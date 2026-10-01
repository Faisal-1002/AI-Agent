import type { AssistantMessage, Event, Message, Part, Session } from "@opencode-ai/sdk/v2";
import type { PermissionRequest } from "@opencode-ai/sdk/v2";
import type { AttachedDocument, ChatEvent, ChatMessage, ChatPart, Conversation, GuardFlags, PermissionAsk } from "../shared/chat.js";
import { displayPath } from "./paths.js";

// Translation layer: OpenCode's rich data model → the small model our UI understands.

// Safety-filter flags are stored in the session's metadata (see server/index.ts).
export function guardFlags(session: Session): GuardFlags {
  return (session.metadata?.guard as GuardFlags | undefined) ?? {};
}

export function toConversation(session: Session): Conversation {
  return { id: session.id, title: session.title, updatedAt: session.time.updated };
}

function attachedDocuments(value: unknown, id: string): ChatPart | undefined {
  if (!Array.isArray(value)) return undefined;
  const documents = value.filter(
    (d): d is AttachedDocument => typeof d?.id === "string" && typeof d?.name === "string",
  );
  return documents.length ? { id, kind: "documents", documents } : undefined;
}

export function toChatPart(part: Part): ChatPart | undefined {
  switch (part.type) {
    case "text":
      if (!part.synthetic) return { id: part.id, kind: "text", text: part.text };
      // Hidden notes aren't shown — except "attached documents", shown as file chips.
      return attachedDocuments(part.metadata?.seylDocuments, part.id);
    case "reasoning":
      return { id: part.id, kind: "reasoning", text: part.text, done: part.time.end !== undefined };
    case "file":
      return part.mime.startsWith("image/")
        ? { id: part.id, kind: "image", mime: part.mime, url: part.url, name: part.filename }
        : undefined;
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
    case "permission.asked":
    case "permission.replied":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

// An approval request from OpenCode → what the UI shows. For edits, OpenCode's metadata
// usually carries the file path and a diff of the proposed change. Paths are shown relative to the
// conversation's folder ("notes.md", not "data/workspaces/<id>/notes.md").
export function toPermissionAsk(request: PermissionRequest, directory: string): PermissionAsk {
  const meta = request.metadata as { filepath?: string; filePath?: string; diff?: string };
  const file = meta.filepath ?? meta.filePath;
  return {
    id: request.id,
    action: request.permission,
    files: (request.patterns.length ? request.patterns : file ? [file] : []).map((p) => displayPath(p, directory)),
    ...(typeof meta.diff === "string" && { diff: meta.diff }),
  };
}

export function toChatEvent(event: Event, directory: string): ChatEvent | undefined {
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
      return { type: "session", title: event.properties.info.title, flags: guardFlags(event.properties.info) };
    case "permission.asked":
      return { type: "permission", ask: toPermissionAsk(event.properties, directory) };
    case "permission.replied":
      return { type: "permission-done", id: event.properties.requestID, reply: event.properties.reply };
    case "session.error": {
      const message = errorText(event.properties.error);
      return message ? { type: "error", message } : { type: "status", busy: false };
    }
    default:
      return undefined;
  }
}
