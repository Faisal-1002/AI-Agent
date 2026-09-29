import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sessionOf, toChatEvent } from "./events.js";
import { client, MODEL } from "./opencode.js";

const PORT = 3000;
const app = new Hono();

// 1. Start a new conversation.
app.post("/api/session", async (c) => {
  const { data, error } = await client.session.create({ title: "seyl-ai chat" }).catch((err) => ({
    data: undefined,
    error: `OpenCode harness not reachable: ${err.message}`,
  }));
  if (!data) return c.json({ error }, 503);
  return c.json({ id: data.id });
});

// 2. Send a message. Returns immediately; the reply arrives on the event stream.
app.post("/api/session/:id/prompt", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const { error } = await client.session.promptAsync({
    sessionID: c.req.param("id"),
    model: MODEL,
    parts: [{ type: "text", text }],
  });
  if (error) return c.json({ error }, 500);
  return c.body(null, 204);
});

// 3. Live stream of what the agent is doing in this session (Server-Sent Events).
app.get("/api/session/:id/events", (c) => {
  const sessionID = c.req.param("id");

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort()); // browser closed the tab → stop listening to OpenCode

    const events = await client.event.subscribe({}, { signal: abort.signal });
    try {
      for await (const event of events.stream) {
        if (sessionOf(event) !== sessionID) continue;
        const chatEvent = toChatEvent(event);
        if (chatEvent) await stream.writeSSE({ data: JSON.stringify(chatEvent) });
      }
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    }
  });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`seyl-ai backend running at http://localhost:${PORT}`);
});
