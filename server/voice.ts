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

// 🎤 was just pressed: load the speech-to-text model while the user is still talking.
// (The voice services unload their models after 15 idle minutes — voice/lazy_model.py.)
// The warm-up is a real, tiny request: half a second of silence.
voice.post("/warm", (c) => {
  const form = new FormData();
  form.append("model", ASR_MODEL);
  form.append("file", new Blob([silentWav(0.5)], { type: "audio/wav" }), "warmup.wav");
  gateway("/v1/audio/transcriptions", { method: "POST", body: form })
    .then((res) => res.body?.cancel())
    .catch(() => {});
  return c.body(null, 202);
});

// A WAV file of silence: 16 kHz, mono, 16-bit — a 44-byte header, then zeros.
function silentWav(seconds: number): ArrayBuffer {
  const rate = 16_000;
  const dataBytes = Math.round(rate * seconds) * 2;
  const view = new DataView(new ArrayBuffer(44 + dataBytes));
  const text = (offset: number, s: string) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per sample
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  return view.buffer;
}

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
