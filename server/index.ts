import "./env.js"; // first: .env before any module reads its settings
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import type { AttachedDocument, ChatEvent, GuardFlags, ModelInfo, PermissionReply, PromptRequest, User } from "../shared/chat.js";
import { AUTH_ENABLED, authRoutes, requireUser } from "./auth.js";
import { migrate } from "./db.js";
import { addDocument, cleanName, deleteDocument, fileType, listDocuments, MAX_UPLOAD_BYTES, readyDocuments, SUPPORTED } from "./documents.js";
import { reviewReply, screenPrompt } from "./guard.js";
import { deviceMcp } from "./mcp.js";
import { tools } from "./tools.js";
import { devices } from "./devices.js";
import { csrfGuard } from "./csrf.js";
import { approvePending, autoApprove, forgetConversation, rememberForConversation, watchApprovals } from "./approvals.js";
import { audit } from "./audit.js";
import { conversationOf, ownedBy, ownsLegacy, recordOwner, type ConversationRecord } from "./owners.js";
import { LEGACY_WORKSPACE, UUID } from "./paths.js";
import { personalSpace } from "./spaces.js";
import { AGENT, client, FAST_VARIANT, MODEL, MODEL_INFO } from "./opencode.js";
import { markUsed, warmUp } from "./warmup.js";
import { inUse, KEEP_OPEN_MS, startIdleCleanup } from "./idle.js";
import { shouldThink } from "./think.js";
import { guardFlags, sessionOf, toChatEvent, toChatMessage, toConversation, toPermissionAsk } from "./translate.js";
import { voice } from "./voice.js";

const PORT = Number(process.env.PORT ?? 3000);
// The agent's document tools (server/tools.ts) call the api on its own port, which nginx doesn't
// forward: browsers (and anyone else reaching the app) can't get to it at all.
const MCP_PORT = Number(process.env.MCP_PORT ?? 3001);
// Only this machine by default (npm run dev); the containers set HOST=0.0.0.0.
const HOST = process.env.HOST ?? "127.0.0.1";
const app = new Hono<{ Variables: { user: User; conversation: ConversationRecord } }>();

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

// Cross-site request protection for everything that changes state (server/csrf.ts).
app.use("/api/*", csrfGuard);
// Sign-in (server/auth.ts). Everything else under /api needs a signed-in user.
app.use("/api/*", requireUser);
app.route(
  "/api/auth",
  authRoutes(async (user) => {
    // Their space and its folder, ready before the first conversation. Not fatal: creating a
    // conversation tries again.
    await personalSpace(user.sub).catch((err: Error) => console.error(`[spaces] ${user.sub}: ${err.message}`));
  }),
);
app.get("/api/readyz", async (c) => {
  const { error } = await client.session.status({}).catch((err: Error) => ({ error: err.message }));
  return error === undefined ? c.json({ ok: true }) : c.json({ ok: false, error }, 503);
});

// The UI asks for this when it opens — a good moment to load the models (server/warmup.ts).
app.get("/api/model", (c) => {
  warmUp();
  return c.json<ModelInfo>(MODEL_INFO);
});

// Connected devices: gateway keys + MCP tokens for the OpenCode CLI, OpenWork… (server/devices.ts).
app.route("/api/devices", devices);
// Their entrance to the document tools — outside /api: no session cookie, the device's own
// token instead (server/mcp.ts). nginx forwards only this exact path.
app.route("/mcp", deviceMcp);

// Speech-to-text and text-to-speech (server/voice.ts).
app.route("/api/voice", voice);

// Document library for "chat with your documents" (server/documents.ts) — each user's own.
const library = async (user: User) => (await personalSpace(user.sub, { folder: false })).id;
app.get("/api/documents", async (c) => c.json(await listDocuments(await library(c.get("user")))));
app.post("/api/documents", bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: "File too large (max 20 MB)" }, 413) }), async (c) => {
  const { file } = await c.req.parseBody();
  if (!(file instanceof File)) return c.json({ error: "Missing file" }, 400);
  if (!SUPPORTED.includes(fileType(file.name))) {
    return c.json({ error: `Unsupported file type. Supported: ${SUPPORTED.join(", ")}` }, 415);
  }
  const doc = await addDocument(file, await library(c.get("user")), c.get("user").sub); // indexing continues in the background
  await audit(c.get("user").sub, "document.upload", doc.id, { name: doc.name, size: doc.size });
  return c.json(doc, 201);
});
app.delete("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await deleteDocument(id, await library(c.get("user"))))) return c.json({ error: "Not found" }, 404);
  await audit(c.get("user").sub, "document.delete", id);
  return c.body(null, 204);
});


// Conversations = OpenCode sessions, each owned by the user who created it and working in that
// user's space folder. Every route with a conversation id checks ownership — someone else's is
// "not found" — and remembers the conversation's folder for the calls below.
const ownConversation = createMiddleware<{ Variables: { user: User; conversation: ConversationRecord } }>(async (c, next) => {
  const conversation = await conversationOf(c.req.param("id") ?? "");
  if (AUTH_ENABLED && conversation?.owner !== c.get("user").sub) return c.json({ error: "Not found" }, 404);
  c.set("conversation", conversation ?? { owner: c.get("user").sub, spaceId: null, directory: null });
  return next();
});
// The folder OpenCode runs a conversation in: its space's — or, for one from before spaces,
// the old shared folder (still readable; the agent no longer works there).
// Calling it marks the folder as in use (server/idle.ts closes folders nobody uses).
const folderOf = (conversation: ConversationRecord) => inUse(conversation.directory ?? LEGACY_WORKSPACE);
app.use("/api/conversations/:id", ownConversation);
app.use("/api/conversations/:id/*", ownConversation);

app.get("/api/conversations", async (c) => {
  const { sub } = c.get("user");
  // OpenCode lists sessions per folder: the user's space, plus the old shared folder if they own
  // conversations from before spaces. Ownership is still checked for each one.
  const folders = [(await personalSpace(sub)).dir, ...((await ownsLegacy(sub)) ? [LEGACY_WORKSPACE] : [])];
  const lists = await Promise.all(folders.map((directory) => client.session.list({ directory: inUse(directory), roots: true, limit: 200 }).then(unwrap)));
  const sessions = lists.flat();
  const mine = AUTH_ENABLED ? await ownedBy(sub) : undefined;
  const conversations = sessions
    .filter((s) => !mine || mine.has(s.id))
    .map(toConversation)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(conversations);
});

app.post("/api/conversations", async (c) => {
  const { sub } = c.get("user");
  const space = await personalSpace(sub);
  const session = unwrap(await client.session.create({ directory: inUse(space.dir) }));
  await recordOwner(session.id, sub, space);
  return c.json(toConversation(session));
});

app.delete("/api/conversations/:id", async (c) => {
  const sessionID = c.req.param("id");
  check(await client.session.delete({ sessionID }));
  await forgetConversation(sessionID);
  await audit(c.get("user").sub, "conversation.delete", sessionID);
  return c.body(null, 204);
});

// Full history, whether the agent is still working on it, and safety-filter flags.
app.get("/api/conversations/:id/messages", async (c) => {
  const sessionID = c.req.param("id");
  const directory = folderOf(c.get("conversation"));
  const [messages, status, session, permissions] = await Promise.all([
    client.session.messages({ sessionID }).then(unwrap),
    client.session.status({ directory }).then(unwrap),
    client.session.get({ sessionID }).then(unwrap),
    client.permission.list({ directory }).then(unwrap),
  ]);
  const busy = status[sessionID] !== undefined && status[sessionID].type !== "idle";
  const pending = [];
  for (const p of permissions.filter((p) => p.sessionID === sessionID)) {
    if (!(await autoApprove(p, directory))) pending.push(toPermissionAsk(p, directory)); // already allowed in this chat → answered
  }
  return c.json({ messages: messages.map(toChatMessage), busy, flags: guardFlags(session), permissions: pending });
});

// Images: the browser resizes them first (fewer image tokens); these are hard limits.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGES = 4;
const MAX_DOCUMENTS = 5;
const MAX_IMAGE_CHARS = 6 * 1024 * 1024; // data URL length (~4.5 MB of image)


// Send a message (text, images and/or documents from the library). The safety filter checks
// the text first; if allowed, the agent starts and this returns immediately — the reply
// arrives on the event stream.
app.post("/api/conversations/:id/prompt", bodyLimit({ maxSize: 30 * 1024 * 1024 }), async (c) => {
  const sessionID = c.req.param("id");
  const { spaceId, directory } = c.get("conversation");
  if (directory) inUse(directory);
  // From before spaces: its agent would work in the old shared folder, which may hold everyone's
  // files. Readable, but closed for new messages.
  if (!spaceId || !directory) {
    return c.json({ error: "This conversation is from before personal workspaces. Start a new conversation to continue." }, 409);
  }
  const body = await c.req.json<PromptRequest>();
  const { text = "", images = [] } = body;
  // Check the shape first: a bad request is the client's mistake (400), not a server error.
  const documentsOk =
    body.documents === undefined ||
    (Array.isArray(body.documents) && body.documents.every((d) => typeof d?.id === "string" && UUID.test(d.id)));
  if (typeof text !== "string" || !Array.isArray(images) || !documentsOk) return c.json({ error: "Invalid message" }, 400);
  const requested = [...new Set((body.documents ?? []).map((d) => d.id.toLowerCase()))];
  if (requested.length > MAX_DOCUMENTS) return c.json({ error: `At most ${MAX_DOCUMENTS} documents per message` }, 400);
  // Names come from the library, not from the request: the model only ever sees real documents.
  const documents = await readyDocuments(requested, spaceId);
  if (documents.length < requested.length) {
    return c.json({ error: "An attached document isn't ready (still indexing, failed, or deleted)." }, 409);
  }
  const think = shouldThink(body.think === true, text) || documents.length > 0;
  if (!text.trim() && images.length === 0 && documents.length === 0) return c.json({ error: "Empty message" }, 400);
  if (images.length > MAX_IMAGES) return c.json({ error: `At most ${MAX_IMAGES} images per message` }, 400);
  for (const image of images) {
    const valid = IMAGE_TYPES.includes(image.mime) && image.dataUrl.startsWith(`data:${image.mime};base64,`);
    if (!valid) return c.json({ error: `Unsupported image: ${image.name}` }, 415);
    if (image.dataUrl.length > MAX_IMAGE_CHARS) return c.json({ error: `Image too large: ${image.name}` }, 413);
  }

  markUsed();
  // Qwen3Guard reads text only: images themselves are NOT moderated (see README, Images).
  const screen = text.trim() ? await screenPrompt(text) : { allowed: true as const };
  if (!screen.allowed) {
    const categories = screen.verdict?.categories ?? [];
    const why = categories.join(", ") || screen.verdict?.safety;
    const error =
      screen.reason ??
      (categories.includes("Suicide & Self-Harm")
        ? "It sounds like you might be going through something really hard. You don't have to face it alone — please consider reaching out to someone you trust, or to a local crisis line or emergency service right now."
        : `Ai-Agent can't help with that — the safety filter flagged it (${why}).`);
    await audit(c.get("user").sub, "prompt.blocked", sessionID, { safety: screen.verdict?.safety, categories, reason: screen.reason ? "unavailable" : undefined });
    return c.json({ error, blocked: screen.verdict }, 422);
  }

  check(await client.session.promptAsync({
    sessionID,
    agent: AGENT, // Ai-Agent's own agent: system prompt + allowed tools (server/opencode.ts)
    model: MODEL,
    variant: think ? undefined : FAST_VARIANT,
    parts: [
      ...(text.trim() ? [{ type: "text" as const, text }] : []),
      // Attached documents: a hidden note for the model (the UI shows it as file chips).
      ...(documents.length ? [attachedDocumentsPart(documents)] : []),
      // Images travel as file parts with a data: URL; OpenCode → gateway → Ollama → the vision model.
      ...images.map((image) => ({ type: "file" as const, mime: image.mime, filename: image.name, url: image.dataUrl })),
    ],
  }));
  void reviewWhenDone(sessionID, directory, text || (documents.length ? "(documents)" : "(image)"), think); // check the reply once the agent finishes
  return c.body(null, 204);
});

// The note that tells the model which library documents came with a message. Synthetic
// (not typed by the user); the metadata lets server/translate.ts show it as file chips.
function attachedDocumentsPart(documents: AttachedDocument[]) {
  // Names are quoted and escaped (JSON), so a file name can't close the note and add its own
  // "instructions" (in a company space, one person's upload would end up in a colleague's chat).
  const names = documents.map((d) => JSON.stringify(cleanName(d.name))).join(", ");
  const one = documents.length === 1;
  return {
    type: "text" as const,
    synthetic: true,
    text: `[The user attached ${one ? "this document" : "these documents"} from their library: ${names}. Read or search ${one ? "it" : "them"} with the docs tools before answering.]`,
    metadata: { aiAgentDocuments: documents },
  };
}

// A hidden follow-up for when the model ends its turn with the answer only in its
// thoughts (a known failure of thinking models after tool calls). Marked synthetic,
// so the UI doesn't show it.
const NUDGE = "(Write your final answer to my last question now, based on what you found. Don't call more tools.)";

// After the agent finishes: make sure there's a visible answer, then run the safety
// filter on it and store any flag in the session's metadata (shown in the UI, survives reloads).
// Note: this runs in the api pod that received the prompt; if that pod stops first,
// it's skipped. A production system would hand this to a queue/worker.
async function reviewWhenDone(sessionID: string, directory: string, prompt: string, think: boolean) {
  try {
    let nudged = false;
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = unwrap(await client.session.status({ directory: inUse(directory) }));
      if (status[sessionID] && status[sessionID].type !== "idle") continue;

      const messages = unwrap(await client.session.messages({ sessionID }));
      // The reply = everything after the user's last REAL message (not our hidden nudge —
      // a message may also be images or documents only, so look for the nudge itself).
      const lastUser = messages.findLastIndex(
        (m) => m.info.role === "user" && !m.parts.some((p) => p.type === "text" && p.text === NUDGE),
      );
      const reply = messages.slice(lastUser + 1).filter((m) => m.info.role === "assistant");
      const last = messages.at(-1)?.info;
      const done = last?.role === "assistant" && last.time.completed !== undefined;
      if (!done || reply.length === 0) continue; // not started yet, or still running

      const text = reply
        .flatMap((m) => m.parts)
        .flatMap((p) => (p.type === "text" && !p.synthetic ? [p.text] : []))
        .join("\n\n");

      // Safety net: the final step wrote nothing visible (and the user didn't press Stop) →
      // ask once for it. A short answer ("4") is fine; only an EMPTY last step is the bug.
      const aborted = last.role === "assistant" && last.error?.name === "MessageAbortedError";
      const lastText = reply.at(-1)!.parts.some((p) => p.type === "text" && !p.synthetic && p.text.trim());
      if (!lastText && !nudged && !aborted) {
        nudged = true;
        console.log(`[agent] ${sessionID}: turn ended without a visible answer — nudging once`);
        check(await client.session.promptAsync({
          sessionID, agent: AGENT, model: MODEL, variant: think ? undefined : FAST_VARIANT,
          parts: [{ type: "text", text: NUDGE, synthetic: true }],
        }));
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
  // The harness knows nothing about users: make sure this request belongs to THIS conversation
  // (which ownConversation already checked is the caller's).
  const requestID = c.req.param("requestID");
  const directory = folderOf(c.get("conversation"));
  const pending = unwrap(await client.permission.list({ directory }));
  const request = pending.find((p) => p.id === requestID && p.sessionID === c.req.param("id"));
  if (!request) return c.json({ error: "Approval request not found" }, 404);
  // "Allow for this chat": sent to OpenCode as "once" — its own "always" would allow it for every
  // chat of every user — and remembered for THIS conversation only (server/approvals.ts), once
  // OpenCode took the answer: of two racing clicks (a double-click, "Allow" in one tab and "Deny"
  // in another) only the one OpenCode accepted counts.
  check(await client.permission.reply({ requestID, reply: reply === "always" ? "once" : reply, directory }));
  if (reply === "always") await rememberForConversation(request);
  const action = reply === "always" ? "approval.this_chat" : reply === "once" ? "approval.once" : "approval.deny";
  await audit(c.get("user").sub, action, request.sessionID, { permission: request.permission, patterns: request.patterns });
  // Whatever the agent asked for meanwhile, or at the same time, that this rule now covers.
  if (reply === "always") await approvePending(request.sessionID).catch(() => {});
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
  const directory = folderOf(c.get("conversation"));
  const send = (stream: { writeSSE(m: { data: string }): Promise<void> }, event: ChatEvent) =>
    stream.writeSSE({ data: JSON.stringify(event) });

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort()); // browser closed the stream → stop listening to OpenCode
    // A chat that's open in a browser is in use, even when nobody types: keep its folder open.
    const keepOpen = setInterval(() => inUse(directory), KEEP_OPEN_MS);
    abort.signal.addEventListener("abort", () => clearInterval(keepOpen));

    // OpenCode's event stream for this conversation's folder (it carries only that folder's events).
    const events = await client.event.subscribe({ directory }, { signal: abort.signal });
    try {
      for await (const event of events.stream) {
        // OpenCode greets every new subscriber; only now is it safe for the UI to send a prompt.
        if (event.type === "server.connected") await send(stream, { type: "ready" });
        if (sessionOf(event) !== sessionID) continue;
        if (event.type === "permission.asked" && (await autoApprove(event.properties, directory))) continue;
        const chatEvent = toChatEvent(event, directory);
        if (chatEvent) await send(stream, chatEvent);
      }
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    } finally {
      clearInterval(keepOpen);
    }
  });
});

// Create Ai-Agent's tables if needed (keeps retrying: the database may start after us).
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
void watchApprovals(); // "Allow for this chat" answers even when the chat isn't open (server/approvals.ts)
startIdleCleanup(); // close folders nobody has used for a while (server/idle.ts)

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Ai-Agent backend running at http://${HOST}:${PORT}`);
});

// The agent's document tools call in here (server/tools.ts) — its own listener, reachable only
// inside the cluster (Service port 3001), never through nginx.
const mcpServer = serve({ fetch: tools.fetch, port: MCP_PORT, hostname: HOST }, () => {
  console.log(`agent tools endpoint running at http://${HOST}:${MCP_PORT}/internal/docs`);
});

// Graceful shutdown: Docker/Kubernetes send SIGTERM before stopping a container.
// Stop accepting new requests, then exit (open event streams are cut after 5s;
// browsers reconnect to another instance automatically).
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down");
  mcpServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
});
