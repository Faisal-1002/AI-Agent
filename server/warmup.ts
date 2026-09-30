import { LLM_GATEWAY_URL } from "./opencode.js";

// Ollama unloads a model after it sits idle (keep_alive: 1 hour, gateway/config.yaml), and
// loading the 9B again takes ~10 s — paid by the first message after a break. So when
// someone opens the app after a long pause, load the models while they're still typing.

const API_KEY = process.env.LITELLM_KEY_API;
// The models on the path of every message: the safety filter first, then the chat model.
const MODELS = ["qwen3-guard", "qwen3.5-9b"];
const IDLE = 50 * 60_000; // a bit less than keep_alive, so we warm up before they're unloaded

let lastUse = 0;

// Something just used the models (a message was sent): they're warm.
export const markUsed = () => void (lastUse = Date.now());

// Fire and forget: load each model with a 1-token request (unless they were used recently).
export function warmUp() {
  if (Date.now() - lastUse < IDLE) return;
  markUsed();
  for (const model of MODELS) {
    fetch(`${LLM_GATEWAY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, reasoning_effort: "none" }),
      signal: AbortSignal.timeout(60_000),
    })
      .then((res) => console.log(`[warmup] ${model}: ${res.ok ? "loaded" : `HTTP ${res.status}`}`))
      .catch((err) => console.log(`[warmup] ${model}: ${(err as Error).message}`));
  }
}
