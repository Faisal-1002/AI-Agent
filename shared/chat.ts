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

// Which voice services are reachable (speech-to-text, text-to-speech).
export type VoiceStatus = { asr: boolean; tts: boolean };

// Live updates streamed to the UI over Server-Sent Events.
export type ChatEvent =
  | { type: "ready" }
  | { type: "message"; messageID: string; role: Role; createdAt: number; error?: string }
  | { type: "part"; messageID: string; part: ChatPart }
  | { type: "delta"; messageID: string; partID: string; delta: string }
  | { type: "status"; busy: boolean }
  | { type: "title"; title: string }
  | { type: "error"; message: string };
