import { CSRF_HEADER, type ChatMessage, type Conversation, type DocumentInfo, type GuardFlags, type ModelInfo, type PermissionAsk, type PermissionReply, type PromptRequest, type User, type VoiceStatus, type DeviceInfo, type NewDevice } from "../../../shared/chat";

// Every call carries the anti-CSRF header (server/csrf.ts): another site can't add it.
const withCsrf = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { [CSRF_HEADER]: "1", ...init.headers } });

// Typed wrappers around the Ai-Agent backend (server/index.ts).
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, withCsrf(init));
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

  devices: () => request<DeviceInfo[]>("/devices"),
  connectDevice: (name: string) =>
    request<NewDevice>("/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }),
  disconnectDevice: (id: string) => request<void>(`/devices/${id}`, { method: "DELETE" }),

  voiceStatus: () => request<VoiceStatus>("/voice/status"),
  // Fire and forget: start loading the speech-to-text model (the 🎤 was just pressed).
  warmVoice: () => void fetch("/api/voice/warm", withCsrf({ method: "POST" })).catch(() => {}),
  transcribe: (audio: Blob) => {
    const form = new FormData();
    form.append("file", audio, audio.type.includes("ogg") ? "recording.ogg" : "recording.webm");
    return request<{ text: string; language: string | null }>("/voice/transcribe", { method: "POST", body: form });
  },
  speak: async (text: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch(
      "/api/voice/speak",
      withCsrf({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal }),
    );
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.blob();
  },
};
