// Ask Ai-Agent a question through the real API and report what the agent did.
//
//   npm run ask -- "What files are in the workspace?"
//   npm run ask -- --runs 3 "According to my documents, …"      # repeat to measure reliability
//   AI_AGENT_URL=http://localhost:5173 npm run ask -- "…"        # against npm run dev
//   npm run ask -- --keep "…"                                     # keep the test conversations
//   npm run ask -- --think "…"                                    # reason first (the UI's Think button)
//
// Each run uses a fresh conversation, deleted afterwards unless --keep is given.
// When login is on, it signs in as AI_AGENT_ASK_USER (default "faisal", password AI_AGENT_USER_PASSWORD).
//
// Reports per run: tools used, seconds, and whether a visible answer came out (a thinking
// model can end a turn with its answer only in its "thoughts" — this makes that measurable).

import { askAgent } from "./lib/ask-agent.js";
import { api } from "./lib/live.js";
import { Session } from "./lib/session.js";

const BASE = process.env.AI_AGENT_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const runsFlag = args.indexOf("--runs");
const runs = runsFlag >= 0 ? Number(args.splice(runsFlag, 2)[1]) : 1;
const keepFlag = args.indexOf("--keep");
const keep = keepFlag >= 0 && args.splice(keepFlag, 1).length > 0;
const thinkFlag = args.indexOf("--think");
const think = thinkFlag >= 0 && args.splice(thinkFlag, 1).length > 0;
const question = args.join(" ").trim();
if (!question) throw new Error('Usage: npm run ask -- [--runs N] "question"');

const session = new Session(BASE);
if ((await session.api("/auth/me")).status === 401) {
  await session.signIn(process.env.AI_AGENT_ASK_USER ?? "faisal", process.env.AI_AGENT_USER_PASSWORD ?? "");
}
const call = api(session);

let answered = 0;
for (let run = 1; run <= runs; run++) {
  const result = await askAgent(call, question, { think, keep });
  if (result.error?.startsWith("refused")) {
    console.log(`run ${run}: ${result.error}`);
    continue;
  }
  const ok = result.answer.length > 0;
  if (ok) answered++;
  console.log(
    `run ${run}: ${ok ? "✓ answered" : "✗ no visible answer"} in ${result.seconds.toFixed(1)}s · thoughts: ${result.thoughts} chars · tools: ${result.tools.join(", ") || "none"}${result.error ? ` · error: ${result.error}` : ""}`,
  );
  if (runs === 1 || !ok) console.log(`   ${result.answer.replace(/\s+/g, " ").slice(0, 400) || "(empty)"}`);
}
if (runs > 1) console.log(`\n${answered}/${runs} runs produced a visible answer`);
