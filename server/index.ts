import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatEvent, GuardFlags, ModelInfo } from "../shared/chat.js";
import { reviewReply, screenPrompt } from "./guard.js";
import { AGENT, client, MODEL, MODEL_INFO } from "./opencode.js";
import { guardFlags, sessionOf, toChatEvent, toChatMessage, toConversation } from "./translate.js";
import { voice } from "./voice.js";

const PORT = Number(process.env.PORT ?? 3000);
const app = new Hono();

// OpenCode SDK calls return { data, error } instead of throwing; these turn
// errors into exceptions, which onError sends back as HTTP 502.
app.onError((err, c) => c.json({ error: err.message }, 502));
function check(result: { error?: unknown }) {
  if (result.error !== undefined) {
    throw new Error(`OpenCode request failed: ${JSON.stringify(result.error)}`);
  }
}
function unwrap<T>(result: { data?: T; error?: unknown }): T {
  check(result);
  if (result.data === undefined) throw new Error("OpenCode request returned no data");
  return result.data;
}

// Health checks:
// - healthz: "is this process alive and able to answer?" — Kubernetes liveness + readiness.
// - readyz:  "is the OpenCode harness reachable too?" — for startup ordering (Compose)
//   and diagnostics. Not used as a Kubernetes readiness probe: a harness restart
//   would then mark every api pod unready at once (a cascading outage).
app.get("/api/healthz", (c) => c.json({ ok: true }));
app.get("/api/readyz", async (c) => {
  const { error } = await client.session.status({}).catch((err: Error) => ({ error: err.message }));
  return error === undefined ? c.json({ ok: true }) : c.json({ ok: false, error }, 503);
});

app.get("/api/model", (c) => c.json<ModelInfo>(MODEL_INFO));

// Speech-to-text and text-to-speech (server/voice.ts).
app.route("/api/voice", voice);

// Conversations = OpenCode sessions.
app.get("/api/conversations", async (c) => {
  const sessions = unwrap(await client.session.list({ roots: true, limit: 100 }));
  const conversations = sessions.map(toConversation).sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(conversations);
});

app.post("/api/conversations", async (c) => {
  return c.json(toConversation(unwrap(await client.session.create({}))));
});

app.delete("/api/conversations/:id", async (c) => {
  check(await client.session.delete({ sessionID: c.req.param("id") }));
  return c.body(null, 204);
});

// Full history, whether the agent is still working on it, and safety-filter flags.
app.get("/api/conversations/:id/messages", async (c) => {
  const sessionID = c.req.param("id");
  const [messages, status, session] = await Promise.all([
    client.session.messages({ sessionID }).then(unwrap),
    client.session.status({}).then(unwrap),
    client.session.get({ sessionID }).then(unwrap),
  ]);
  const busy = status[sessionID] !== undefined && status[sessionID].type !== "idle";
  return c.json({ messages: messages.map(toChatMessage), busy, flags: guardFlags(session) });
});

// Send a message. The safety filter checks it first; if allowed, the agent starts and
// this returns immediately — the reply arrives on the event stream.
app.post("/api/conversations/:id/prompt", async (c) => {
  const sessionID = c.req.param("id");
  const { text } = await c.req.json<{ text: string }>();

  const screen = await screenPrompt(text);
  if (!screen.allowed) {
    const categories = screen.verdict?.categories ?? [];
    const why = categories.join(", ") || screen.verdict?.safety;
    const error =
      screen.reason ??
      (categories.includes("Suicide & Self-Harm")
        ? "It sounds like you might be going through something really hard. You don't have to face it alone — please consider reaching out to someone you trust, or to a local crisis line or emergency service right now."
        : `seyl-ai can't help with that — the safety filter flagged it (${why}).`);
    return c.json({ error, blocked: screen.verdict }, 422);
  }

  check(await client.session.promptAsync({
    sessionID,
    agent: AGENT, // seyl-ai's own agent: system prompt + allowed tools (server/opencode.ts)
    model: MODEL,
    parts: [{ type: "text", text }],
  }));
  void reviewWhenDone(sessionID, text); // check the reply once the agent finishes
  return c.body(null, 204);
});

// After the agent finishes, run the safety filter on its reply and store any flag in
// the session's metadata (the UI shows it; it survives reloads).
// Note: this runs in the api pod that received the prompt; if that pod stops first,
// the check is skipped. A production system would hand this to a queue/worker.
async function reviewWhenDone(sessionID: string, prompt: string) {
  try {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = unwrap(await client.session.status({}));
      if (status[sessionID] && status[sessionID].type !== "idle") continue;

      const messages = unwrap(await client.session.messages({ sessionID }));
      const lastUser = messages.findLastIndex((m) => m.info.role === "user");
      const reply = messages.slice(lastUser + 1);
      const last = reply.at(-1)?.info;
      const done = last?.role === "assistant" && last.time.completed !== undefined;
      if (!done) continue; // not started yet, or still running

      const text = reply
        .flatMap((m) => m.parts)
        .flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))
        .join("\n\n");
      const verdict = await reviewReply(prompt, text);
      if (!verdict) return;

      const session = unwrap(await client.session.get({ sessionID }));
      const guard: GuardFlags = { ...guardFlags(session), [reply[0].info.id]: verdict };
      check(await client.session.update({ sessionID, metadata: { ...session.metadata, guard } }));
      return;
    }
  } catch (err) {
    console.error("[guard] reply review failed:", (err as Error).message);
  }
}

// Stop the agent mid-reply.
app.post("/api/conversations/:id/abort", async (c) => {
  check(await client.session.abort({ sessionID: c.req.param("id") }));
  return c.body(null, 204);
});

// Live stream of what the agent is doing in this conversation (Server-Sent Events).
app.get("/api/conversations/:id/events", (c) => {
  const sessionID = c.req.param("id");
  const send = (stream: { writeSSE(m: { data: string }): Promise<void> }, event: ChatEvent) =>
    stream.writeSSE({ data: JSON.stringify(event) });

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort()); // browser closed the stream → stop listening to OpenCode

    const events = await client.event.subscribe({}, { signal: abort.signal });
    try {
      for await (const event of events.stream) {
        // OpenCode greets every new subscriber; only now is it safe for the UI to send a prompt.
        if (event.type === "server.connected") await send(stream, { type: "ready" });
        if (sessionOf(event) !== sessionID) continue;
        const chatEvent = toChatEvent(event);
        if (chatEvent) await send(stream, chatEvent);
      }
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    }
  });
});

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`seyl-ai backend running at http://localhost:${PORT}`);
});

// Graceful shutdown: Docker/Kubernetes send SIGTERM before stopping a container.
// Stop accepting new requests, then exit (open event streams are cut after 5s;
// browsers reconnect to another instance automatically).
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
});
