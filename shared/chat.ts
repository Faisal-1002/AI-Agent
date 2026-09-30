// Types shared by the backend (server/) and the web UI (web/).
// The backend translates OpenCode's data into these; the UI only knows these.

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type ChatPart =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "reasoning"; text: string; done: boolean }
  | {
      id: string;
      kind: "tool";
      tool: string;
      status: ToolStatus;
      title?: string;
      input: Record<string, unknown>;
      output?: string;
      error?: string;
    };

export type Role = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: Role;
  createdAt: number;
  parts: ChatPart[];
  error?: string;
};

export type Conversation = { id: string; title: string; updatedAt: number };

export type ModelInfo = { provider: string; name: string };

// An uploaded document in the searchable library (server/documents.ts).
export type DocumentInfo = {
  id: string;
  name: string;
  type: string; // file extension, e.g. "pdf"
  size: number; // bytes
  status: "indexing" | "ready" | "failed";
  error?: string;
  chunks: number;
  createdAt: string;
};

// Which voice services are reachable (speech-to-text, text-to-speech).
export type VoiceStatus = { asr: boolean; tts: boolean };

// The safety filter's (Qwen3Guard) judgement of a message or reply.
export type GuardVerdict = {
  safety: "Safe" | "Controversial" | "Unsafe";
  categories: string[]; // e.g. ["Violent"]; empty when Safe
  refusal?: boolean; // replies only: did the assistant decline?
  source?: "model" | "rules"; // who flagged it: Qwen3Guard, or the pattern rules (server/pii.ts)
};

// Replies the safety filter flagged, keyed by the id of the reply's first message
// (the same id the UI uses for that turn). Stored in the OpenCode session's metadata.
export type GuardFlags = Record<string, GuardVerdict>;

// Live updates streamed to the UI over Server-Sent Events.
export type ChatEvent =
  | { type: "ready" }
  | { type: "message"; messageID: string; role: Role; createdAt: number; error?: string }
  | { type: "part"; messageID: string; part: ChatPart }
  | { type: "delta"; messageID: string; partID: string; delta: string }
  | { type: "status"; busy: boolean }
  | { type: "session"; title: string; flags: GuardFlags }
  | { type: "error"; message: string };
