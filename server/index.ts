import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatEvent, ModelInfo } from "../shared/chat.js";
import { client, MODEL, MODEL_INFO } from "./opencode.js";
import { sessionOf, toChatEvent, toChatMessage, toConversation } from "./translate.js";

const PORT = 3000;
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

app.get("/api/model", (c) => c.json<ModelInfo>(MODEL_INFO));

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

// Full history, plus whether the agent is still working on it.
app.get("/api/conversations/:id/messages", async (c) => {
  const sessionID = c.req.param("id");
  const [messages, status] = await Promise.all([
    client.session.messages({ sessionID }).then(unwrap),
    client.session.status({}).then(unwrap),
  ]);
  const busy = status[sessionID] !== undefined && status[sessionID].type !== "idle";
  return c.json({ messages: messages.map(toChatMessage), busy });
});

// Send a message. Returns immediately; the reply arrives on the event stream.
app.post("/api/conversations/:id/prompt", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  check(await client.session.promptAsync({
    sessionID: c.req.param("id"),
    model: MODEL,
    parts: [{ type: "text", text }],
  }));
  return c.body(null, 204);
});

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

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`seyl-ai backend running at http://localhost:${PORT}`);
});
