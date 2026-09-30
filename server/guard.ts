import { readFileSync } from "node:fs";
import type { GuardVerdict } from "../shared/chat.js";
import { LLM_GATEWAY_URL } from "./opencode.js";
import { findPII } from "./pii.js";

// The safety filter: Qwen3Guard classifies text as Safe / Controversial / Unsafe.
//
// This is where safety is ENFORCED. The agent's system prompt only asks the model to
// behave; a clever prompt can talk a model out of that. This check runs in our backend,
// outside the model, on every message — the user can't prompt their way past it.
//
// GUARD_MODE:  enforce (default) — block unsafe messages, flag unsafe replies
//              monitor           — check and flag, but never block (for tuning)
//              off               — no checks
// GUARD_STRICT=true also blocks "Controversial" messages.

const MODE = (process.env.GUARD_MODE ?? "enforce") as "enforce" | "monitor" | "off";
const STRICT = process.env.GUARD_STRICT === "true";
const API_KEY = process.env.LITELLM_KEY_API;
const GUARD_MODEL = "qwen3-guard";

// The model's official moderation prompt (scripts/guard-template.ts extracts it).
type Template = { before: string; after: string };
const TEMPLATE = JSON.parse(readFileSync(new URL("./guard-template.json", import.meta.url), "utf8")) as {
  prompt: Template;
  response: Template;
};

export function parseVerdict(output: string): GuardVerdict {
  const safety = /Safety: (Safe|Unsafe|Controversial)/.exec(output)?.[1] as GuardVerdict["safety"] | undefined;
  if (!safety) throw new Error(`Unexpected guard output: ${JSON.stringify(output.slice(0, 120))}`);
  const categories = (/Categories: (.*)/.exec(output)?.[1] ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c && c !== "None");
  const refusal = /Refusal: (Yes|No)/.exec(output)?.[1];
  return { safety, categories, ...(refusal && { refusal: refusal === "Yes" }) };
}

async function classify(kind: "prompt" | "response", conversation: string): Promise<GuardVerdict> {
  const { before, after } = TEMPLATE[kind];
  const res = await fetch(`${LLM_GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GUARD_MODEL,
      messages: [{ role: "user", content: before + conversation + after }],
      max_tokens: 64,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Guard request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseVerdict((await res.json()).choices[0].message.content ?? "");
}

// Same conversation format as the official template: "USER: …" then "ASSISTANT: …".
export const checkPrompt = (text: string) => classify("prompt", `USER: ${text}`);
export const checkResponse = (prompt: string, reply: string) =>
  classify("response", `USER: ${prompt}\n\nASSISTANT: ${reply}`);

// Our POLICY, layered on the classifier's labels. The model labels; we decide.
// Found by scripts/guard-eval.ts: the guard often rates jailbreak attempts only
// "Controversial" (while tagging them "Jailbreak") — so the category decides too.
export function decide(v: GuardVerdict): "block" | "allow" {
  if (v.safety === "Unsafe") return "block";
  if (v.categories.includes("Jailbreak")) return "block"; // attempts to override the assistant's rules
  if (STRICT && v.safety === "Controversial") return "block";
  return "allow";
}

const isBlocked = (v: GuardVerdict) => decide(v) === "block";

// Decide whether a user message may reach the agent.
// If the guard itself is down, fail CLOSED: an unchecked message never gets through.
export async function screenPrompt(text: string): Promise<{ allowed: boolean; verdict?: GuardVerdict; reason?: string }> {
  if (MODE === "off") return { allowed: true };
  try {
    const verdict = await checkPrompt(text);
    if (verdict.safety !== "Safe") console.log(`[guard] prompt ${verdict.safety}: ${verdict.categories.join(", ")}`);
    return { allowed: MODE === "monitor" || !isBlocked(verdict), verdict };
  } catch (err) {
    console.error("[guard] check failed:", (err as Error).message);
    if (MODE === "monitor") return { allowed: true };
    return { allowed: false, reason: "The safety filter is unavailable right now, so messages can't be checked. Try again in a minute." };
  }
}

// Assess a reply with both layers: the model, then the pattern rules as a backstop.
export async function assessReply(prompt: string, reply: string): Promise<GuardVerdict> {
  const verdict: GuardVerdict = { ...(await checkResponse(prompt, reply)), source: "model" };
  if (verdict.safety !== "Safe") return verdict;
  const pii = findPII(reply);
  return pii.length ? { safety: "Unsafe", categories: ["PII"], refusal: verdict.refusal, source: "rules" } : verdict;
}

// Review a finished reply. Returns a verdict worth showing (anything not Safe), or undefined.
export async function reviewReply(prompt: string, reply: string): Promise<GuardVerdict | undefined> {
  if (MODE === "off" || !reply.trim()) return undefined;
  const verdict = await assessReply(prompt, reply);
  if (verdict.safety !== "Safe") console.log(`[guard] reply ${verdict.safety} (${verdict.source}): ${verdict.categories.join(", ")}`);
  return verdict.safety === "Safe" ? undefined : verdict;
}
