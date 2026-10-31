import type { ChatMessage } from "../../shared/chat.js";

// One question to the real agent through the app's API, in a fresh conversation: what it
// answered, which tools it used, how long it took. Used by npm run ask and npm run rag:eval.

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

export type AgentRun = {
  answer: string; // the visible reply ("" if the turn ended without one)
  tools: string[]; // e.g. "docs_search_documents", "read (error)"
  thoughts: number; // characters of hidden reasoning
  seconds: number;
  error?: string; // refused by the safety filter, or the turn failed
};

export async function askAgent(call: Call, text: string, { think = false, keep = false } = {}): Promise<AgentRun> {
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  const { id } = await call<{ id: string }>("/conversations", { method: "POST" });
  try {
    try {
      await call(`/conversations/${id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, think }),
      });
    } catch (err) {
      return { answer: "", tools: [], thoughts: 0, seconds: seconds(), error: `refused — ${(err as Error).message}` };
    }

    // Wait until the agent is done (busy=false and the last message is a finished reply).
    let messages: ChatMessage[] = [];
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const state = await call<{ messages: ChatMessage[]; busy: boolean }>(`/conversations/${id}/messages`);
      messages = state.messages;
      if (!state.busy && messages.at(-1)?.role === "assistant" && messages.at(-1)?.parts.length) break;
      if (Date.now() - started > 10 * 60_000) return { answer: "", tools: [], thoughts: 0, seconds: seconds(), error: "timed out" };
    }

    const parts = messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts);
    const errors = messages.flatMap((m) => (m.error ? [m.error] : []));
    return {
      answer: parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n").trim(),
      tools: parts.flatMap((p) => (p.kind === "tool" ? [`${p.tool}${p.status === "error" ? " (error)" : ""}`] : [])),
      thoughts: parts.reduce((n, p) => n + (p.kind === "reasoning" ? p.text.length : 0), 0),
      seconds: seconds(),
      ...(errors.length && { error: errors.join("; ") }),
    };
  } finally {
    if (!keep) await call(`/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  }
}
