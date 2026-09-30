// Ask seyl-ai a question through the real API and report what the agent did.
//
//   npm run ask -- "What files are in the workspace?"
//   npm run ask -- --runs 3 "According to my documents, …"      # repeat to measure reliability
//   SEYL_URL=http://localhost:5173 npm run ask -- "…"            # against npm run dev
//   npm run ask -- --keep "…"                                     # keep the test conversations
//
// Each run uses a fresh conversation, deleted afterwards unless --keep is given.
// When login is on, it signs in as SEYL_ASK_USER (default "faisal", password SEYL_USER_PASSWORD).
//
// Reports per run: tools used, seconds, and whether a visible answer came out (a thinking
// model can end a turn with its answer only in its "thoughts" — this makes that measurable).

import type { ChatMessage } from "../shared/chat.js";
import { Session } from "./lib/session.js";

try {
  process.loadEnvFile();
} catch {}

const BASE = process.env.SEYL_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const runsFlag = args.indexOf("--runs");
const runs = runsFlag >= 0 ? Number(args.splice(runsFlag, 2)[1]) : 1;
const keepFlag = args.indexOf("--keep");
const keep = keepFlag >= 0 && args.splice(keepFlag, 1).length > 0;
const question = args.join(" ").trim();
if (!question) throw new Error('Usage: npm run ask -- [--runs N] "question"');

const session = new Session(BASE);
if ((await session.api("/auth/me")).status === 401) {
  await session.signIn(process.env.SEYL_ASK_USER ?? "faisal", process.env.SEYL_USER_PASSWORD ?? "");
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await session.api(path, init);
  const body = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body?.error ?? res.statusText}`);
  return body as T;
}

let answered = 0;
for (let run = 1; run <= runs; run++) {
  const started = Date.now();
  const { id } = await call<{ id: string }>("/conversations", { method: "POST" });
  try {
    await call(`/conversations/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: question }),
    });
  } catch (err) {
    console.log(`run ${run}: refused — ${(err as Error).message}`);
    continue;
  }

  // Wait until the agent is done (busy=false and the last message is a finished reply).
  let messages: ChatMessage[] = [];
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const state = await call<{ messages: ChatMessage[]; busy: boolean }>(`/conversations/${id}/messages`);
    messages = state.messages;
    if (!state.busy && messages.at(-1)?.role === "assistant") break;
    if (Date.now() - started > 10 * 60_000) throw new Error("timed out");
  }

  const parts = messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts);
  const tools = parts.flatMap((p) => (p.kind === "tool" ? [`${p.tool}${p.status === "error" ? " (error)" : ""}`] : []));
  const answer = parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n").trim();
  const errors = messages.flatMap((m) => (m.error ? [m.error] : []));
  const ok = answer.length > 40;
  if (ok) answered++;
  console.log(
    `run ${run}: ${ok ? "✓ answered" : "✗ no visible answer"} in ${((Date.now() - started) / 1000).toFixed(0)}s · tools: ${tools.join(", ") || "none"}${errors.length ? ` · error: ${errors.join("; ")}` : ""}`,
  );
  if (runs === 1 || !ok) console.log(`   ${answer.replace(/\s+/g, " ").slice(0, 400) || "(empty)"}`);
  if (!keep) await call(`/conversations/${id}`, { method: "DELETE" });
}
if (runs > 1) console.log(`\n${answered}/${runs} runs produced a visible answer`);
