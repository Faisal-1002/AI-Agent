// Live test for closing idle folders (server/idle.ts). For the test, the api closes folders after
// ONE minute (instead of 30); the setting is put back at the end. A temporary user chats, then:
//  - while the chat is open in a "browser" (the live event stream), its folder stays open;
//  - once nobody watches, the folder is closed;
//  - the conversation still works afterwards (the folder opens again).
//
//   npm run idle:test     (stack on Kubernetes; about five minutes)

import type { ChatMessage } from "../shared/chat.js";
import { api, APP, check, finish, kubectl, psql, safe, spaceFolder, temporaryUsers, waitFor } from "./lib/live.js";

const setEnv = (...vars: string[]) => {
  kubectl("set", "env", "deploy/api", ...vars);
  kubectl("rollout", "status", "deploy/api", "--timeout=180s");
};
// The folder's row: is it closed (closed after its last use)?
const closed = (folder: string) =>
  psql(`SELECT coalesce(closed_at > last_used_at, false) FROM harness_folders WHERE directory = '${folder.replaceAll("'", "")}'`) === "t";

setEnv("AI_AGENT_IDLE_MINUTES=1", "AI_AGENT_IDLE_CHECK_SECONDS=15");
const users = await temporaryUsers();

try {
  const { session, sub } = await users.create("idle");
  const call = api(session);
  const folder = spaceFolder(sub);
  const answers = async (id: string) => {
    const s = await call<{ busy: boolean; messages: ChatMessage[] }>(`/conversations/${id}/messages`);
    return { busy: s.busy, count: s.messages.filter((m) => m.role === "assistant" && m.parts.some((p) => p.kind === "text")).length };
  };
  // Send a message and wait for a NEW answer (right after sending, the agent may not be busy yet).
  const ask = async (id: string, text: string) => {
    const before = (await answers(id)).count;
    await call(`/conversations/${id}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, think: false }) });
    return waitFor(async () => {
      const now = await answers(id);
      return !now.busy && now.count > before ? now.count - before : undefined;
    });
  };

  const { id } = await call<{ id: string }>("/conversations", { method: "POST" });
  safe(id);
  check((await ask(id, "Reply with just the word: hello")) !== undefined, "a first message gets an answer");
  check(psql(`SELECT count(*) FROM harness_folders WHERE directory = '${folder}'`) === "1", "the api noted the folder as in use");

  // An open chat (the browser's live event stream) keeps its folder open past the idle limit.
  const watching = new AbortController();
  const stream = await session.go(`${APP}/api/conversations/${id}/events`, { signal: watching.signal });
  const reader = stream.body?.getReader();
  void (async () => {
    try {
      while (reader && !(await reader.read()).done);
    } catch {}
  })();
  await new Promise((resolve) => setTimeout(resolve, 100_000));
  check(stream.ok && !closed(folder), "while the chat is open (100 s, limit 60 s), its folder stays open");

  // Nobody watching any more: closed within the limit plus a check or two.
  watching.abort();
  const wasClosed = await waitFor(() => closed(folder), 150);
  check(wasClosed === true, "once nobody uses it, the folder is closed");
  const logs = kubectl("logs", "-l", "app=api", "--tail=200", "--prefix");
  check(logs.includes(`[idle] closed ${folder}`), "…and the api says so in its log");

  // The conversation still works: the folder opens again.
  check((await ask(id, "Reply with just the word: again")) !== undefined, "the conversation still works afterwards (a new answer)");
  check(!closed(folder), "…and its folder is open again");

  await call(`/conversations/${id}`, { method: "DELETE" });
} finally {
  await users.cleanup();
  setEnv("AI_AGENT_IDLE_MINUTES-", "AI_AGENT_IDLE_CHECK_SECONDS-"); // back to the normal settings
}

finish("all idle-folder checks passed");
