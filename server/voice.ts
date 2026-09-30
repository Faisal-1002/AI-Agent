import { Hono } from "hono";
import type { VoiceStatus } from "../shared/chat.js";
import { toSpeakable } from "../shared/speech.js";

// The voice services (voice/asr and voice/tts). Both speak OpenAI's audio API,
// so either could later be swapped for a hosted service or a LiteLLM gateway.
const ASR_URL = process.env.ASR_URL ?? "http://127.0.0.1:8001";
const TTS_URL = process.env.TTS_URL ?? "http://127.0.0.1:8002";
const TTS_VOICE = process.env.TTS_VOICE ?? "Aiden";

export const voice = new Hono();

// Call a voice service; if it can't be reached (e.g. restarting), say so plainly.
async function call(service: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`The ${service} service is unavailable right now (it may be restarting). Try again in a minute.`);
  }
}

// Which voice features are reachable right now; the UI only shows buttons that work.
voice.get("/status", async (c) => {
  const up = (url: string) =>
    fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  const [asr, tts] = await Promise.all([up(ASR_URL), up(TTS_URL)]);
  return c.json<VoiceStatus>({ asr, tts });
});

// 🎤 Recorded audio from the browser → text.
voice.post("/transcribe", async (c) => {
  const { file } = await c.req.parseBody();
  if (!(file instanceof File)) return c.json({ error: "Missing audio file" }, 400);

  const form = new FormData();
  form.append("file", file, file.name || "recording.webm");
  const res = await call("speech-to-text", `${ASR_URL}/v1/audio/transcriptions`, { method: "POST", body: form });
  if (!res.ok) return c.json({ error: `Speech-to-text failed: ${await res.text()}` }, 502);
  return c.json(await res.json());
});

// 🔊 Text → spoken audio (WAV), streamed straight back to the browser.
// The UI sends a long reply in sentence chunks (shared/speech.ts), one request each.
voice.post("/speak", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const input = toSpeakable(text);
  if (!input) return c.json({ error: "Nothing to read aloud" }, 400);

  const res = await call("text-to-speech", `${TTS_URL}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, voice: TTS_VOICE }),
  });
  if (!res.ok) return c.json({ error: `Text-to-speech failed: ${await res.text()}` }, 502);
  return new Response(res.body, { headers: { "Content-Type": "audio/wav" } });
});

