import type { ChatMessage, Conversation, ModelInfo } from "../../../shared/chat";

// Typed wrappers around the seyl-ai backend (server/index.ts).
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  model: () => request<ModelInfo>("/model"),
  conversations: () => request<Conversation[]>("/conversations"),
  createConversation: () => request<Conversation>("/conversations", { method: "POST" }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  messages: (id: string) =>
    request<{ messages: ChatMessage[]; busy: boolean }>(`/conversations/${id}/messages`),
  prompt: (id: string, text: string) =>
    request<void>(`/conversations/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  abort: (id: string) => request<void>(`/conversations/${id}/abort`, { method: "POST" }),
  eventsUrl: (id: string) => `/api/conversations/${id}/events`,
};
