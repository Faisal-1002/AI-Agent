import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { ChatEvent, GuardFlags, ImageAttachment, ModelInfo, PermissionReply } from "../shared/chat.js";
import { migrate } from "./db.js";
import { addDocument, deleteDocument, fileType, listDocuments, MAX_UPLOAD_BYTES, SUPPORTED } from "./documents.js";
import { reviewReply, screenPrompt } from "./guard.js";
import { mcp } from "./mcp.js";
import { AGENT, client, MODEL, MODEL_INFO } from "./opencode.js";
import { guardFlags, sessionOf, toChatEvent, toChatMessage, toConversation, toPermissionAsk } from "./translate.js";
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

// Document library for "chat with your documents" (server/documents.ts).
app.get("/api/documents", async (c) => c.json(await listDocuments()));
app.post("/api/documents", bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: "File too large (max 20 MB)" }, 413) }), async (c) => {
  const { file } = await c.req.parseBody();
  if (!(file instanceof File)) return c.json({ error: "Missing file" }, 400);
  if (!SUPPORTED.includes(fileType(file.name))) {
    return c.json({ error: `Unsupported file type. Supported: ${SUPPORTED.join(", ")}` }, 415);
  }
  return c.json(await addDocument(file), 201); // indexing continues in the background
});
app.delete("/api/documents/:id", async (c) => (await deleteDocument(c.req.param("id")) ? c.body(null, 204) : c.json({ error: "Not found" }, 404)));

// MCP tool server for the agent (server/mcp.ts). Deliberately outside /api: not proxied to browsers.
app.route("/mcp", mcp);

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
  const [messages, status, session, permissions] = await Promise.all([
    client.session.messages({ sessionID }).then(unwrap),
    client.session.status({}).then(unwrap),
    client.session.get({ sessionID }).then(unwrap),
    client.permission.list({}).then(unwrap),
  ]);
  const busy = status[sessionID] !== undefined && status[sessionID].type !== "idle";
  const pending = permissions.filter((p) => p.sessionID === sessionID).map(toPermissionAsk);
  return c.json({ messages: messages.map(toChatMessage), busy, flags: guardFlags(session), permissions: pending });
});

// Images: the browser resizes them first (fewer image tokens); these are hard limits.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024; // data URL length (~4.5 MB of image)

// Send a message (text and/or images). The safety filter checks the text first; if allowed,
// the agent starts and this returns immediately — the reply arrives on the event stream.
app.post("/api/conversations/:id/prompt", bodyLimit({ maxSize: 30 * 1024 * 1024 }), async (c) => {
  const sessionID = c.req.param("id");
  const { text = "", images = [] } = await c.req.json<{ text?: string; images?: ImageAttachment[] }>();
  if (!text.trim() && images.length === 0) return c.json({ error: "Empty message" }, 400);
  if (images.length > MAX_IMAGES) return c.json({ error: `At most ${MAX_IMAGES} images per message` }, 400);
  for (const image of images) {
    const valid = IMAGE_TYPES.includes(image.mime) && image.dataUrl.startsWith(`data:${image.mime};base64,`);
    if (!valid) return c.json({ error: `Unsupported image: ${image.name}` }, 415);
    if (image.dataUrl.length > MAX_IMAGE_CHARS) return c.json({ error: `Image too large: ${image.name}` }, 413);
  }

  // Qwen3Guard reads text only: images themselves are NOT moderated (see README, Images).
  const screen = text.trim() ? await screenPrompt(text) : { allowed: true as const };
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
    parts: [
      ...(text.trim() ? [{ type: "text" as const, text }] : []),
      // Images travel as file parts with a data: URL; OpenCode → gateway → Ollama → the vision model.
      ...images.map((image) => ({ type: "file" as const, mime: image.mime, filename: image.name, url: image.dataUrl })),
    ],
  }));
  void reviewWhenDone(sessionID, text || "(image)"); // check the reply once the agent finishes
  return c.body(null, 204);
});

// A hidden follow-up for when the model ends its turn with the answer only in its
// thoughts (a known failure of thinking models after tool calls). Marked synthetic,
// so the UI doesn't show it.
const NUDGE = "(Write your final answer to my last question now, based on what you found. Don't call more tools.)";

// After the agent finishes: make sure there's a visible answer, then run the safety
// filter on it and store any flag in the session's metadata (shown in the UI, survives reloads).
// Note: this runs in the api pod that received the prompt; if that pod stops first,
// it's skipped. A production system would hand this to a queue/worker.
async function reviewWhenDone(sessionID: string, prompt: string) {
  try {
    let nudged = false;
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = unwrap(await client.session.status({}));
      if (status[sessionID] && status[sessionID].type !== "idle") continue;

      const messages = unwrap(await client.session.messages({ sessionID }));
      // The reply = everything after the user's last REAL message (not our hidden nudge).
      const lastUser = messages.findLastIndex(
        (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && !p.synthetic),
      );
      const reply = messages.slice(lastUser + 1).filter((m) => m.info.role === "assistant");
      const last = messages.at(-1)?.info;
      const done = last?.role === "assistant" && last.time.completed !== undefined;
      if (!done || reply.length === 0) continue; // not started yet, or still running

      const text = reply
        .flatMap((m) => m.parts)
        .flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))
        .join("\n\n");

      // Safety net: no visible answer (and the user didn't press Stop) → ask once for it.
      const aborted = last.role === "assistant" && last.error?.name === "MessageAbortedError";
      if (text.trim().length < 20 && !nudged && !aborted) {
        nudged = true;
        console.log(`[agent] ${sessionID}: turn ended without a visible answer — nudging once`);
        check(await client.session.promptAsync({ sessionID, agent: AGENT, model: MODEL, parts: [{ type: "text", text: NUDGE, synthetic: true }] }));
        continue;
      }

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

// Answer an approval request (the agent is paused until this arrives).
app.post("/api/conversations/:id/permissions/:requestID", async (c) => {
  const { reply } = await c.req.json<{ reply: PermissionReply }>();
  if (!["once", "always", "reject"].includes(reply)) return c.json({ error: "Invalid reply" }, 400);
  check(await client.permission.reply({ requestID: c.req.param("requestID"), reply }));
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

// Create seyl-ai's tables if needed (keeps retrying: the database may start after us).
async function migrateWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate();
      console.log("database ready");
      return;
    } catch (err) {
      console.error(`database not ready (attempt ${attempt}): ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2_000 * attempt)));
    }
  }
}
void migrateWithRetry();

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
