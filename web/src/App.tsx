import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import type { ChatEvent } from "../../server/events";

type Part =
  | { id: string; kind: "text" | "reasoning"; text: string }
  | { id: string; kind: "tool"; tool: string; status: string };

type Message = { id: string; role: "user" | "assistant"; parts: Part[] };

type State = { messages: Message[]; busy: boolean; error?: string };

// Apply one event from the backend to the chat state.
function reducer(state: State, event: ChatEvent | { type: "sent" }): State {
  if (event.type === "sent") return { ...state, busy: true, error: undefined };
  if (event.type === "idle") return { ...state, busy: false };
  if (event.type === "error") return { ...state, busy: false, error: event.message };

  const messages = [...state.messages];
  let index = messages.findIndex((m) => m.id === event.messageID);
  if (index === -1) {
    messages.push({ id: event.messageID, role: "assistant", parts: [] });
    index = messages.length - 1;
  }
  const message = { ...messages[index] };
  messages[index] = message;

  if (event.type === "message") {
    message.role = event.role;
    return { ...state, messages };
  }

  if (event.type === "delta") {
    // Append streamed tokens to the part they belong to.
    const existing = message.parts.find((p) => p.id === event.partID);
    const text = (existing && existing.kind !== "tool" ? existing.text : "") + event.delta;
    const part: Part = { id: event.partID, kind: existing?.kind === "reasoning" ? "reasoning" : "text", text };
    message.parts = existing
      ? message.parts.map((p) => (p.id === part.id ? part : p))
      : [...message.parts, part];
    return { ...state, messages };
  }

  const part: Part =
    event.type === "tool"
      ? { id: event.partID, kind: "tool", tool: event.tool, status: event.status }
      : { id: event.partID, kind: event.type, text: event.text };
  const partIndex = message.parts.findIndex((p) => p.id === part.id);
  message.parts = partIndex === -1
    ? [...message.parts, part]
    : message.parts.map((p, i) => (i === partIndex ? part : p));
  return { ...state, messages };
}

export function App() {
  const [sessionID, setSessionID] = useState<string>();
  const [state, dispatch] = useReducer(reducer, { messages: [], busy: false });
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);

  // Create a session once, then listen to its live event stream.
  useEffect(() => {
    let cancelled = false; // React dev mode runs effects twice; ignore the first run's result
    let source: EventSource | undefined;
    fetch("/api/session", { method: "POST" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        return body as { id: string };
      })
      .then(({ id }) => {
        if (cancelled) return;
        setSessionID(id);
        source = new EventSource(`/api/session/${id}/events`);
        source.onmessage = (e) => dispatch(JSON.parse(e.data) as ChatEvent);
      })
      .catch((err: Error) => {
        if (!cancelled) dispatch({ type: "error", message: `${err.message} (refresh to retry)` });
      });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !sessionID || state.busy) return;
    setInput("");
    dispatch({ type: "sent" });
    await fetch(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  return (
    <main>
      <header>
        <h1>seyl-ai</h1>
        <span className="model">OpenCode · Qwen3 8B (local)</span>
      </header>

      <section className="messages">
        {state.messages.length === 0 && (
          <p className="empty">Ask something — e.g. “What files are in the workspace?”</p>
        )}
        {state.messages.map((m) => (
          <div key={m.id} className={`message ${m.role}`}>
            {m.parts.map((p) =>
              p.kind === "reasoning" ? (
                <details key={p.id} className="reasoning">
                  <summary>Thinking</summary>
                  <p>{p.text}</p>
                </details>
              ) : p.kind === "tool" ? (
                <div key={p.id} className={`tool ${p.status}`}>
                  🔧 {p.tool} <span>{p.status}</span>
                </div>
              ) : (
                <p key={p.id}>{p.text}</p>
              ),
            )}
          </div>
        ))}
        {state.busy && <div className="status">seyl-ai is working…</div>}
        {state.error && <div className="error">Error: {state.error}</div>}
        <div ref={bottom} />
      </section>

      <form onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={sessionID ? "Message seyl-ai…" : "Connecting…"}
          disabled={!sessionID}
          autoFocus
        />
        <button disabled={!sessionID || state.busy || !input.trim()}>Send</button>
      </form>
    </main>
  );
}
