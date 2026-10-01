// Types shared by the backend (server/) and the web UI (web/).
// The backend translates OpenCode's data into these; the UI only knows these.

// Every state-changing API request must send this header with the value "1" (server/csrf.ts).
export const CSRF_HEADER = "X-Seyl-Csrf";

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type ChatPart =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "reasoning"; text: string; done: boolean }
  | { id: string; kind: "image"; mime: string; url: string; name?: string } // url: a data: URL
  | { id: string; kind: "documents"; documents: AttachedDocument[] } // library documents attached to a message
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

export type ModelInfo = { provider: string; name: string; vision: boolean };

// The signed-in person (from the OIDC ID token). `local`: login is off (npm run dev).
export type User = { sub: string; name: string; email?: string; username?: string; local?: boolean };

// An image attached to a message (already resized in the browser).
export type ImageAttachment = { name: string; mime: string; dataUrl: string };

// A document from the library, attached to a message (the agent reads it with its docs tools).
export type AttachedDocument = { id: string; name: string };

// File types the document library can index (server/documents.ts extracts their text).
export const DOCUMENT_TYPES = ["pdf", "docx", "md", "txt", "csv", "json", "html"];

// POST /api/conversations/:id/prompt. think: true = reason first (slower; default off).
export type PromptRequest = { text?: string; images?: ImageAttachment[]; documents?: AttachedDocument[]; think?: boolean };

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

// "Connect a device" (server/devices.ts): an app such as the OpenCode CLI or OpenWork desktop,
// connected to Seyl with its own model key and document-tools token.
export type DeviceInfo = { id: string; name: string; createdAt: string; lastUsedAt?: string; expiresAt: string };

// Returned ONCE, when a device is connected: the two secrets are never shown again.
export type NewDevice = { device: DeviceInfo; apiKey: string; mcpToken: string; gatewayUrl: string; mcpUrl: string; models: string[] };

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

// The agent is paused, asking the user to approve an action (e.g. editing a file).
export type PermissionAsk = {
  id: string;
  action: string; // "edit" = create or change a file
  files: string[]; // what it wants to touch
  diff?: string; // the proposed change, when available
};
export type PermissionReply = "once" | "always" | "reject";

// Live updates streamed to the UI over Server-Sent Events.
export type ChatEvent =
  | { type: "ready" }
  | { type: "message"; messageID: string; role: Role; createdAt: number; error?: string }
  | { type: "part"; messageID: string; part: ChatPart }
  | { type: "delta"; messageID: string; partID: string; delta: string }
  | { type: "status"; busy: boolean }
  | { type: "session"; title: string; flags: GuardFlags }
  | { type: "permission"; ask: PermissionAsk }
  | { type: "permission-done"; id: string; reply: PermissionReply }
  | { type: "error"; message: string };
