import { Hono } from "hono";
import type { VoiceStatus } from "../shared/chat.js";
import { toSpeakable } from "../shared/speech.js";
import { LLM_GATEWAY_URL } from "./opencode.js";

// Voice goes through the LiteLLM gateway like every other model call. This API's
// key may use only the two voice models (scripts/gateway-keys.ts).
const API_KEY = process.env.LITELLM_KEY_API;
const ASR_MODEL = "qwen3-asr";
const TTS_MODEL = "qwen3-tts";
const TTS_VOICE = process.env.TTS_VOICE ?? "Aiden";

export const voice = new Hono();

// Call the gateway; if it can't be reached, say so plainly.
async function gateway(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${LLM_GATEWAY_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${API_KEY}`, ...init.headers },
    });
  } catch {
    throw new Error("The model gateway is unavailable right now. Try again in a minute.");
  }
}

// Which voice models this API may use; the UI only shows buttons that work.
// (The gateway lists only the models our key is allowed to call.)
voice.get("/status", async (c) => {
  const res = await gateway("/v1/models", { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  const models: string[] = res?.ok ? ((await res.json()).data ?? []).map((m: { id: string }) => m.id) : [];
  return c.json<VoiceStatus>({ asr: models.includes(ASR_MODEL), tts: models.includes(TTS_MODEL) });
});

// 🎤 Recorded audio from the browser → text.
voice.post("/transcribe", async (c) => {
  const { file } = await c.req.parseBody();
  if (!(file instanceof File)) return c.json({ error: "Missing audio file" }, 400);

  const form = new FormData();
  form.append("model", ASR_MODEL);
  form.append("file", file, file.name || "recording.webm");
  const res = await gateway("/v1/audio/transcriptions", { method: "POST", body: form });
  if (!res.ok) return c.json({ error: `Speech-to-text failed: ${await res.text()}` }, 502);
  const { text, language } = await res.json();
  return c.json({ text, language });
});

// 🔊 Text → spoken audio (WAV), streamed straight back to the browser.
// The UI sends a long reply in sentence chunks (shared/speech.ts), one request each.
voice.post("/speak", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const input = toSpeakable(text);
  if (!input) return c.json({ error: "Nothing to read aloud" }, 400);

  const res = await gateway("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, input, voice: TTS_VOICE }),
  });
  if (!res.ok) return c.json({ error: `Text-to-speech failed: ${await res.text()}` }, 502);
  return new Response(res.body, { headers: { "Content-Type": "audio/wav" } });
});
