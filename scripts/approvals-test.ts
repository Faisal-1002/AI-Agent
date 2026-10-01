// Live test for approvals and the audit log (server/approvals.ts, server/audit.ts). A TEMPORARY
// user asks the agent to create files and answers the approval cards; the test checks who gets
// asked, what lands in the user's folder and what the audit log recorded. Everything it creates
// (user, conversations, files, space) is removed again.
//
//   npm run approvals:test     (stack on Kubernetes; reaches the folders and database via kubectl)
//
// Uses the model for a few small file edits: a minute or two.

import type { PermissionAsk } from "../shared/chat.js";
import { api, check, finish, inApi, inHarness, kubectl, psql, safe, spaceFolder, temporaryUsers, waitFor } from "./lib/live.js";

// ── Infrastructure checks (no model needed) ──

const anonymous = inApi(`fetch("http://harness:4097/session").then(r => console.log(r.status), e => console.log("error: " + e.message))`);
check(anonymous === "401", `the harness refuses a request without its password (got ${anonymous})`);
const policy = kubectl("logs", "deploy/harness", "-c", "harness").split("\n").find((line) => line.startsWith("policy check passed")) ?? "";
check(policy.includes("docs_search_documents"), `the harness's startup check passed, document tools loaded ("${policy.slice(0, 80)}…")`);

// ── A temporary user ──

const users = await temporaryUsers();
const conversations: string[] = [];
const tag = Math.random().toString(16).slice(2, 8);
const files = [1, 2, 3].map((n) => `approvals-test-${tag}-${n}.md`);
let signedIn: ReturnType<typeof api> | undefined; // to delete what is left if a check throws

try {
  const { session, sub } = await users.create("approvals");
  const call = api(session);
  signedIn = call;
  const folder = spaceFolder(sub);
  const state = (id: string) => call<{ busy: boolean; permissions: PermissionAsk[] }>(`/conversations/${id}/messages`);
  const prompt = (id: string, text: string) =>
    call(`/conversations/${id}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, think: false }) });
  const answer = (id: string, ask: PermissionAsk, reply: "once" | "always" | "reject") =>
    call(`/conversations/${id}/permissions/${ask.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply }) });
  const idle = (id: string) => waitFor(async () => !(await state(id)).busy || undefined);
  const createFile = (file: string, content: string) => `Create a new file named ${file} containing exactly the text: ${content}`;
  const inFolder = (file: string) => inHarness(`${folder}/${file}`);

  // 1. Chat A asks; "Allow for this chat".
  const a = safe((await call<{ id: string }>("/conversations", { method: "POST" })).id);
  conversations.push(a);
  await prompt(a, createFile(files[0], "one"));
  const first = await waitFor(async () => (await state(a)).permissions[0]);
  check(first?.action === "edit" && first.files.includes(files[0]), `chat A: the first edit asks first, path shown relative to the user's folder (${first?.action} ${first?.files.join(", ")})`);
  // A double-click: two "Allow for this chat" at once. OpenCode takes one; the rule must survive
  // whichever of the two loses (an earlier version could delete it again).
  if (first) {
    const clicks = await Promise.allSettled([answer(a, first, "always"), answer(a, first, "always")]);
    check(clicks.some((c) => c.status === "fulfilled"), `chat A: "Allow for this chat" (double-click: ${clicks.map((c) => (c.status === "fulfilled" ? "ok" : "refused")).join(" + ")})`);
  }
  check((await waitFor(() => inFolder(files[0]))) === true, "chat A: approved → the file is in the user's own folder");
  check(psql(`SELECT count(*) FROM approval_rules WHERE session_id = '${a}'`) === "1", "chat A: the double-click left exactly one rule");
  await idle(a);

  // 2. Same chat, nobody watching (no event stream open, no page polling): the api's watcher
  //    must answer it — before, only an open chat could.
  await prompt(a, createFile(files[1], "two"));
  check((await waitFor(() => inFolder(files[1]))) === true, "chat A: the next edit goes through without asking, with no chat open");
  await idle(a);

  // 3. Another chat of the same user: asked again — the approval was for chat A only.
  const b = safe((await call<{ id: string }>("/conversations", { method: "POST" })).id);
  conversations.push(b);
  await prompt(b, createFile(files[2], "three"));
  const other = await waitFor(async () => (await state(b)).permissions[0]);
  check(other !== undefined, "chat B: asked again (\"Allow for this chat\" did not leak to another chat)");
  if (other) await answer(b, other, "reject");
  await idle(b);
  check(!inFolder(files[2]), "chat B: denied → no file");

  // 4. The audit log.
  const actions = psql(`SELECT action || ' ' || coalesce(target, '') FROM audit.log WHERE actor = '${safe(sub)}' ORDER BY id`).split("\n");
  const count = (line: string) => actions.filter((l) => l === line).length;
  check(count("login ") === 1, "audit: the sign-in");
  check(actions.some((l) => l.startsWith("space.create ")), "audit: the user's space was created");
  check(count(`approval.this_chat ${a}`) === 1, "audit: \"Allow for this chat\" in chat A");
  const autos = count(`approval.auto ${a}`);
  check(autos >= 1, `audit: the automatic approval in chat A (${autos}× — once per request, however many api pods raced)`);
  check(count(`approval.deny ${b}`) === 1, "audit: the denial in chat B");
  check(psql(`SELECT count(*) FROM approval_rules WHERE session_id = '${a}'`) === "1", "chat A still has exactly one approval rule");
  let tampered = true;
  try {
    psql(`UPDATE audit.log SET actor = 'someone else' WHERE actor = '${safe(sub)}'`);
  } catch {
    tampered = false;
  }
  check(!tampered, "audit: the api's database user can't change the log");

  // 5. Deleting a chat deletes its rules (and is audited).
  for (const id of conversations.splice(0)) await call(`/conversations/${id}`, { method: "DELETE" });
  check(psql(`SELECT count(*) FROM approval_rules WHERE session_id = '${a}'`) === "0", "deleting chat A deleted its rule");
  check(psql(`SELECT count(*) FROM audit.log WHERE actor = '${safe(sub)}' AND action = 'conversation.delete'`) === "2", "audit: both deletions");
} finally {
  for (const id of conversations) await signedIn?.(`/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  await users.cleanup();
}

finish("all approval and audit checks passed");
