import type { ChatMessage, Conversation, DocumentInfo, GuardFlags, ModelInfo, PermissionAsk, PermissionReply, PromptRequest, User, VoiceStatus } from "../../../shared/chat";

// Typed wrappers around the seyl-ai backend (server/index.ts).
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  // Session expired (or signed out in another tab): reload, and the login screen appears.
  if (res.status === 401 && path !== "/auth/me") window.location.reload();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  me: () => request<{ user: User }>("/auth/me"),
  logout: () => request<{ logoutUrl: string }>("/auth/logout", { method: "POST" }),

  model: () => request<ModelInfo>("/model"),
  conversations: () => request<Conversation[]>("/conversations"),
  createConversation: () => request<Conversation>("/conversations", { method: "POST" }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  messages: (id: string) =>
    request<{ messages: ChatMessage[]; busy: boolean; flags: GuardFlags; permissions: PermissionAsk[] }>(`/conversations/${id}/messages`),
  prompt: (id: string, body: PromptRequest) =>
    request<void>(`/conversations/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  answerPermission: (id: string, requestID: string, reply: PermissionReply) =>
    request<void>(`/conversations/${id}/permissions/${requestID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    }),
  abort: (id: string) => request<void>(`/conversations/${id}/abort`, { method: "POST" }),
  eventsUrl: (id: string) => `/api/conversations/${id}/events`,

  documents: () => request<DocumentInfo[]>("/documents"),
  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<DocumentInfo>("/documents", { method: "POST", body: form });
  },
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: "DELETE" }),

  voiceStatus: () => request<VoiceStatus>("/voice/status"),
  // Fire and forget: start loading the speech-to-text model (the 🎤 was just pressed).
  warmVoice: () => void fetch("/api/voice/warm", { method: "POST" }).catch(() => {}),
  transcribe: (audio: Blob) => {
    const form = new FormData();
    form.append("file", audio, audio.type.includes("ogg") ? "recording.ogg" : "recording.webm");
    return request<{ text: string; language: string | null }>("/voice/transcribe", { method: "POST", body: form });
  },
  speak: async (text: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.blob();
  },
};
