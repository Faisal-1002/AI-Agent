import type { ChatEvent, ChatMessage, ChatPart, GuardFlags, PermissionAsk } from "../../../shared/chat";

// flags: replies the safety filter flagged (keyed by turn id).
// permissions: approval requests the agent is waiting on.
export type ChatState = {
  messages: ChatMessage[];
  busy: boolean;
  flags: GuardFlags;
  permissions: PermissionAsk[];
  error?: string;
};

export type ChatAction =
  | ChatEvent
  | { type: "reset"; messages: ChatMessage[]; busy: boolean; flags: GuardFlags; permissions: PermissionAsk[] }
  | { type: "sending" }
  | { type: "failed"; message: string };

export const initialChat: ChatState = { messages: [], busy: false, flags: {}, permissions: [] };

// Apply a change to one message, creating it if this is the first we hear of it.
function updateMessage(
  messages: ChatMessage[],
  id: string,
  change: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === id);
  if (index === -1) {
    return [...messages, change({ id, role: "assistant", createdAt: Date.now(), parts: [] })];
  }
  return messages.map((m, i) => (i === index ? change(m) : m));
}

function upsertPart(parts: ChatPart[], part: ChatPart): ChatPart[] {
  const index = parts.findIndex((p) => p.id === part.id);
  return index === -1 ? [...parts, part] : parts.map((p, i) => (i === index ? part : p));
}

function appendDelta(parts: ChatPart[], partID: string, delta: string): ChatPart[] {
  const existing = parts.find((p) => p.id === partID);
  if (!existing) return [...parts, { id: partID, kind: "text", text: delta }];
  if (existing.kind !== "text" && existing.kind !== "reasoning") return parts; // tools, images: no text deltas
  return parts.map((p) => (p === existing ? { ...existing, text: existing.text + delta } : p));
}

// Pure function: (current chat, one event) → next chat. Easy to test and reason about.
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return { messages: action.messages, busy: action.busy, flags: action.flags, permissions: action.permissions };
    case "sending":
      return { ...state, busy: true, error: undefined };
    case "failed":
    case "error":
      return { ...state, busy: false, error: action.message };
    case "status":
      return { ...state, busy: action.busy };
    case "message":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageID, (m) => ({
          ...m,
          role: action.role,
          createdAt: action.createdAt,
          error: action.error,
        })),
      };
    case "part":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageID, (m) => ({
          ...m,
          parts: upsertPart(m.parts, action.part),
        })),
      };
    case "delta":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageID, (m) => ({
          ...m,
          parts: appendDelta(m.parts, action.partID, action.delta),
        })),
      };
    case "session":
      return { ...state, flags: action.flags };
    case "permission":
      return { ...state, permissions: [...state.permissions.filter((p) => p.id !== action.ask.id), action.ask] };
    case "permission-done":
      return { ...state, permissions: state.permissions.filter((p) => p.id !== action.id) };
    case "ready":
      return state;
  }
}
