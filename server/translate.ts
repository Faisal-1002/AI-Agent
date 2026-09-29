import type { AssistantMessage, Event, Message, Part, Session } from "@opencode-ai/sdk/v2";
import type { ChatEvent, ChatMessage, ChatPart, Conversation } from "../shared/chat.js";

// Translation layer: OpenCode's rich data model → the small model our UI understands.

export function toConversation(session: Session): Conversation {
  return { id: session.id, title: session.title, updatedAt: session.time.updated };
}

export function toChatPart(part: Part): ChatPart | undefined {
  switch (part.type) {
    case "text":
      return part.synthetic ? undefined : { id: part.id, kind: "text", text: part.text };
    case "reasoning":
      return { id: part.id, kind: "reasoning", text: part.text, done: part.time.end !== undefined };
    case "tool": {
      const { state } = part;
      return {
        id: part.id,
        kind: "tool",
        tool: part.tool,
        status: state.status,
        title: "title" in state ? state.title : undefined,
        input: state.input,
        output: state.status === "completed" ? state.output : undefined,
        error: state.status === "error" ? state.error : undefined,
      };
    }
    default:
      return undefined; // step markers, snapshots, patches, … — not shown
  }
}

// Returns undefined for "stopped by the user", which isn't an error worth showing.
export function errorText(error: AssistantMessage["error"]): string | undefined {
  if (!error || error.name === "MessageAbortedError") return undefined;
  const data = "data" in error ? (error.data as { message?: unknown }) : undefined;
  return typeof data?.message === "string" ? data.message : error.name;
}

export function toChatMessage(message: { info: Message; parts: Part[] }): ChatMessage {
  const { info } = message;
  return {
    id: info.id,
    role: info.role,
    createdAt: info.time.created,
    parts: message.parts.map(toChatPart).filter((p) => p !== undefined),
    error: info.role === "assistant" ? errorText(info.error) : undefined,
  };
}

// Which session an OpenCode event belongs to (undefined = not session-specific).
export function sessionOf(event: Event): string | undefined {
  switch (event.type) {
    case "message.updated":
    case "message.part.updated":
    case "message.part.delta":
    case "session.status":
    case "session.idle":
    case "session.updated":
    case "session.error":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

export function toChatEvent(event: Event): ChatEvent | undefined {
  switch (event.type) {
    case "message.updated": {
      const { info } = event.properties;
      const error = info.role === "assistant" ? errorText(info.error) : undefined;
      return { type: "message", messageID: info.id, role: info.role, createdAt: info.time.created, error };
    }
    case "message.part.updated": {
      const part = toChatPart(event.properties.part);
      return part && { type: "part", messageID: event.properties.part.messageID, part };
    }
    // While the model is generating, text arrives a few tokens at a time.
    case "message.part.delta": {
      const { messageID, partID, field, delta } = event.properties;
      return field === "text" ? { type: "delta", messageID, partID, delta } : undefined;
    }
    case "session.status":
      return { type: "status", busy: event.properties.status.type !== "idle" };
    case "session.idle":
      return { type: "status", busy: false };
    case "session.updated":
      return { type: "title", title: event.properties.info.title };
    case "session.error": {
      const message = errorText(event.properties.error);
      return message ? { type: "error", message } : { type: "status", busy: false };
    }
    default:
      return undefined;
  }
}
