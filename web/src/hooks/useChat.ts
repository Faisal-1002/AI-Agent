import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AttachedDocument, ChatEvent, Conversation, ImageAttachment, PermissionReply } from "../../../shared/chat";
import { api } from "../lib/api";
import { chatReducer, initialChat } from "../lib/chatReducer";

type Handlers = {
  onCreated: (conversation: Conversation) => void;
  onTitle: (id: string, title: string) => void;
};

type Stream = { id: string; source: EventSource; openedBySend: boolean };

// Owns one conversation's messages: loads history, listens to live events, sends and stops.
export function useChat(conversationId: string | undefined, handlers: Handlers) {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const stream = useRef<Stream | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Open the live event stream; resolves once the backend is subscribed to OpenCode,
  // so a prompt sent afterwards can't "miss" the start of its reply.
  const connect = useCallback((id: string, openedBySend: boolean) => {
    stream.current?.source.close();
    const source = new EventSource(api.eventsUrl(id));
    stream.current = { id, source, openedBySend };

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to seyl-ai")), 10_000);
      source.onmessage = (e) => {
        const event = JSON.parse(e.data) as ChatEvent;
        if (event.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
        if (event.type === "session") handlersRef.current.onTitle(id, event.title);
        dispatch(event);
      };
    });
  }, []);

  // Switching conversations: load its history and listen for live updates.
  useEffect(() => {
    if (!conversationId) {
      stream.current?.source.close();
      stream.current = null;
      dispatch({ type: "reset", messages: [], busy: false, flags: {}, permissions: [] });
      return;
    }
    // send() just created this conversation and is already streaming it.
    if (stream.current?.id === conversationId && stream.current.openedBySend) return;

    let cancelled = false;
    dispatch({ type: "reset", messages: [], busy: false, flags: {}, permissions: [] });
    api
      .messages(conversationId)
      .then(({ messages, busy, flags, permissions }) => !cancelled && dispatch({ type: "reset", messages, busy, flags, permissions }))
      .catch((err: Error) => !cancelled && dispatch({ type: "failed", message: err.message }));
    connect(conversationId, false).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, connect]);

  // Close the stream when the chat view goes away.
  useEffect(() => () => stream.current?.source.close(), []);

  const send = useCallback(
    async (text: string, images: ImageAttachment[] = [], think = false, documents: AttachedDocument[] = []): Promise<boolean> => {
      dispatch({ type: "sending" });
      try {
        let id = conversationId;
        if (!id) {
          // Like LibreChat: a conversation is only created when its first message is sent.
          const conversation = await api.createConversation();
          id = conversation.id;
          await connect(id, true);
          handlersRef.current.onCreated(conversation);
        }
        await api.prompt(id, { text, images, think, documents });
        return true;
      } catch (err) {
        dispatch({ type: "failed", message: (err as Error).message });
        return false;
      }
    },
    [conversationId, connect],
  );

  // Answer an approval request. Remove it right away; the event stream confirms it.
  const answerPermission = useCallback(
    (requestID: string, reply: PermissionReply) => {
      if (!conversationId) return;
      dispatch({ type: "permission-done", id: requestID, reply });
      api.answerPermission(conversationId, requestID, reply).catch((err: Error) => dispatch({ type: "failed", message: err.message }));
    },
    [conversationId],
  );

  const stop = useCallback(() => {
    if (conversationId) api.abort(conversationId).catch(() => {});
  }, [conversationId]);

  return { ...state, send, stop, answerPermission };
}
