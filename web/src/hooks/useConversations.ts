import { useCallback, useEffect, useState } from "react";
import type { Conversation } from "../../../shared/chat";
import { api } from "../lib/api";

// The sidebar's list of conversations (OpenCode sessions).
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([]);

  const refresh = useCallback(() => {
    api.conversations().then(setConversations).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const add = useCallback((conversation: Conversation) => {
    setConversations((list) => [conversation, ...list.filter((c) => c.id !== conversation.id)]);
  }, []);

  const rename = useCallback((id: string, title: string) => {
    setConversations((list) =>
      list.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c)),
    );
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.deleteConversation(id);
    setConversations((list) => list.filter((c) => c.id !== id));
  }, []);

  return { conversations, refresh, add, rename, remove };
}
