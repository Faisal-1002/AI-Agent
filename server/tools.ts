import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { listDocuments, readDocument, searchDocuments } from "./documents.js";
import { inUse } from "./idle.js";
import { conversationOf } from "./owners.js";

// The document tools, as text for the model — and the internal endpoint the agent's tools call.
//
// The agent's tools (harness-config/opencode/tools/docs.js) run inside the harness and POST here
// with the conversation id and folder that OpenCode gave them (never the model). This endpoint
// looks up who owns that conversation and answers from THAT space's library only. It listens on
// the api's internal port (MCP_PORT, 3001), which nginx never forwards, and needs the shared
// AI_AGENT_MCP_TOKEN — so only the harness can call it, and only for conversations that exist.
// Connected devices get the same tools over MCP, scoped by their own token (server/mcp.ts).

export async function searchText(space: string, query: string, limit = 5): Promise<string> {
  const hits = await searchDocuments(query, space, limit);
  return hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.document} — passage ${h.position + 1} (${h.reranked ? "answers the question" : "similarity"}: ${h.score.toFixed(2)})\n${h.content}`).join("\n\n---\n\n")
    : "No documents have been uploaded yet, or nothing matched.";
}

export async function listText(space: string): Promise<string> {
  const docs = await listDocuments(space);
  return docs.length
    ? docs.map((d) => `- ${d.name} (${d.type}, ${Math.ceil(d.size / 1024)} KB, ${d.status}${d.status === "ready" ? `, ${d.chunks} passages` : ""})`).join("\n")
    : "No documents uploaded yet.";
}

export async function readText(space: string, name: string, page: number): Promise<string> {
  const doc = await readDocument(name, space, page);
  return doc ? `${doc.name} — page ${doc.page} of ${doc.pages}\n\n${doc.text}` : `No ready document named "${name}". Use list_documents to see the names.`;
}

const TOKEN = process.env.AI_AGENT_MCP_TOKEN;
if (TOKEN !== undefined && TOKEN.length < 32) throw new Error("AI_AGENT_MCP_TOKEN must be at least 32 characters");
if (!TOKEN) console.warn("[tools] AI_AGENT_MCP_TOKEN is not set: the agent's document tools are disabled");

// Compare in constant time (hash both sides first, so lengths match too): a plain !== returns
// earlier the more characters are wrong, which leaks the token bit by bit over many tries.
const digest = (value: string) => createHash("sha256").update(value).digest();
const tokenOk = (header: string | undefined) => !!TOKEN && timingSafeEqual(digest(header ?? ""), digest(`Bearer ${TOKEN}`));

// The same folder? (path.relative is case-insensitive on Windows, like its file system.)
const sameFolder = (a: string, b: string) => path.relative(path.resolve(a), path.resolve(b)) === "";

type ToolCall = { sessionID?: unknown; directory?: unknown; args?: unknown };

export const tools = new Hono();

tools.post("/internal/docs/:op", async (c) => {
  if (!tokenOk(c.req.header("authorization"))) return c.json({ error: "Unauthorized" }, 401);
  const body = (await c.req.json().catch(() => undefined)) as ToolCall | undefined;
  if (typeof body?.sessionID !== "string" || typeof body.directory !== "string") return c.json({ error: "Bad request" }, 400);

  // Whose conversation? Its space decides which library — and the folder OpenCode ran the tool in
  // must be that conversation's own (a second, independent check).
  const conversation = await conversationOf(body.sessionID);
  if (!conversation?.spaceId || !conversation.directory || !sameFolder(conversation.directory, body.directory)) {
    return c.json({ error: "This conversation has no document library (start a new conversation)." }, 403);
  }
  const space = conversation.spaceId;
  inUse(conversation.directory);
  // OpenCode doesn't validate custom tools' arguments: check them here.
  const args = (typeof body.args === "object" && body.args !== null ? body.args : {}) as Record<string, unknown>;

  switch (c.req.param("op")) {
    case "search": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length < 2) return c.json({ error: "query: describe what to look for (at least 2 characters)." }, 400);
      return c.json({ text: await searchText(space, query.slice(0, 1000)) });
    }
    case "list":
      return c.json({ text: await listText(space) });
    case "read": {
      const name = typeof args.name === "string" ? args.name : "";
      const page = Number.isInteger(args.page) && (args.page as number) >= 1 ? (args.page as number) : 1;
      if (!name) return c.json({ error: "name: the document's file name, as shown by docs_list_documents." }, 400);
      return c.json({ text: await readText(space, name.slice(0, 300), page) });
    }
    default:
      return c.json({ error: "Unknown tool" }, 404);
  }
});
