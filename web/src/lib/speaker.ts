import { useSyncExternalStore } from "react";
import { speechChunks } from "../../../shared/speech";
import { api } from "./api";

// One shared audio player for the whole app: starting a new read-aloud stops the old one.
//
// On a CPU, Qwen3-TTS needs ~2.4 s of work per second of speech. So a reply is read in
// sentence chunks: the first starts after a few seconds, and chunk n+1 is generated while
// chunk n plays (a small pipeline) instead of waiting for the whole reply.

type Phase = "idle" | "loading" | "playing" | "error";
type State = { id: string | null; phase: Phase; error?: string };

let state: State = { id: null, phase: "idle" };
let audio: HTMLAudioElement | null = null;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  listeners.forEach((listener) => listener());
}

function stop() {
  controller?.abort(); // cancel the chunk being generated
  controller = null;
  audio?.pause();
  audio = null;
  set({ id: null, phase: "idle" });
}

// Play one chunk; resolves when it finishes (or is stopped).
function play(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio = new Audio(url);
    audio.onended = done;
    signal.addEventListener("abort", done);
    audio.play().catch(reject);
  });
}

async function speak(id: string, text: string) {
  stop();
  const chunks = speechChunks(text);
  if (chunks.length === 0) return;

  const own = new AbortController();
  controller = own;
  set({ id, phase: "loading" });
  try {
    let next = api.speak(chunks[0], own.signal);
    for (let i = 0; i < chunks.length; i++) {
      const blob = await next;
      if (own.signal.aborted) return;
      // Start generating the following chunk now, while this one plays.
      if (i + 1 < chunks.length) next = api.speak(chunks[i + 1], own.signal);
      set({ id, phase: "playing" });
      await play(blob, own.signal);
      if (own.signal.aborted) return;
      if (i + 1 < chunks.length) set({ id, phase: "loading" }); // waiting for the next chunk
    }
    if (controller === own) stop();
  } catch (err) {
    if (!own.signal.aborted) set({ id, phase: "error", error: (err as Error).message });
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// For one message: its read-aloud phase, and a toggle to start (or retry) / stop.
export function useSpeaker(id: string, text: string) {
  const current = useSyncExternalStore(subscribe, () => state);
  const mine = current.id === id;
  const phase: Phase = mine ? current.phase : "idle";
  const toggle = () => (phase === "idle" || phase === "error" ? speak(id, text) : stop());
  return { phase, toggle, error: mine ? current.error : undefined };
}
