import type { Event } from "@opencode-ai/sdk/v2";

// The small, stable set of events our web UI understands.
// OpenCode emits ~90 event types; the backend translates the few we need.
export type ChatEvent =
  | { type: "message"; messageID: string; role: "user" | "assistant" }
  | { type: "text"; messageID: string; partID: string; text: string }
  | { type: "reasoning"; messageID: string; partID: string; text: string }
  | { type: "delta"; messageID: string; partID: string; delta: string }
  | { type: "tool"; messageID: string; partID: string; tool: string; status: string }
  | { type: "idle" }
  | { type: "error"; message: string };

// Which session an OpenCode event belongs to (undefined = global event).
export function sessionOf(event: Event): string | undefined {
  switch (event.type) {
    case "message.updated":
    case "message.part.updated":
    case "message.part.delta":
    case "session.idle":
    case "session.error":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

export function toChatEvent(event: Event): ChatEvent | undefined {
  switch (event.type) {
    case "message.updated":
      return { type: "message", messageID: event.properties.info.id, role: event.properties.info.role };

    case "message.part.updated": {
      const part = event.properties.part;
      if (part.type === "text" || part.type === "reasoning") {
        // We send the full text so far, not just the delta: simpler and self-healing.
        return { type: part.type, messageID: part.messageID, partID: part.id, text: part.text };
      }
      if (part.type === "tool") {
        return {
          type: "tool",
          messageID: part.messageID,
          partID: part.id,
          tool: part.tool,
          status: part.state.status,
        };
      }
      return undefined; // step markers, snapshots, etc. — not shown yet
    }

    // While the model is generating, text arrives a few tokens at a time.
    case "message.part.delta": {
      const { messageID, partID, field, delta } = event.properties;
      return field === "text" ? { type: "delta", messageID, partID, delta } : undefined;
    }

    case "session.idle":
      return { type: "idle" };

    case "session.error": {
      const error = event.properties.error;
      const message = error && "data" in error && typeof error.data?.message === "string"
        ? error.data.message
        : (error?.name ?? "Unknown error");
      return { type: "error", message };
    }

    default:
      return undefined;
  }
}
