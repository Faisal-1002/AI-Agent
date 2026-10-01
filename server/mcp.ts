import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { deviceOwner } from "./devices.js";
import { personalSpace } from "./spaces.js";
import { listText, readText, searchText } from "./tools.js";

// seyl-ai's MCP server: the document tools for connected devices.
//
// MCP (Model Context Protocol) is the open standard for giving agents tools. A device that the
// user connected (the OpenCode CLI, OpenWork… — server/devices.ts) reaches it through nginx at
// /mcp with its own revocable token; the token says whose device it is, so the tools see only
// that user's library. Any other MCP client (Claude, Cursor, …) could use them the same way.
//
// (The harness's own agent used to come in here too, with one shared token — which couldn't tell
// users apart. It now uses custom tools that know the conversation: server/tools.ts.)
// The MCP spec's optional OAuth 2.1 flow is meant for third-party clients we don't know; our
// devices get their tokens from a signed-in user on the "Connect a device" page instead.

function createServer(space: string): McpServer {
  const server = new McpServer({ name: "seyl-docs", version: "1.0.0" });
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  server.registerTool(
    "search_documents",
    {
      description:
        "Search the user's uploaded documents by meaning (semantic search) and return the most relevant passages with their document names. Use this for any question that the user's documents might answer. Phrase the query as a question or a description of what you're looking for.",
      inputSchema: {
        query: z.string().min(2).max(1000).describe("What to look for, in natural language"),
        limit: z.number().int().min(1).max(10).optional().describe("How many passages to return (default 5)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => text(await searchText(space, query, limit ?? 5)),
  );

  server.registerTool(
    "list_documents",
    {
      description: "List the documents the user has uploaded (name, type, size, whether they're searchable yet).",
      annotations: { readOnlyHint: true },
    },
    async () => text(await listText(space)),
  );

  server.registerTool(
    "read_document",
    {
      description: "Read the full text of one uploaded document, a page at a time. Use it to summarize a document or when search results aren't enough.",
      inputSchema: {
        name: z.string().max(300).describe("The document's file name, as shown by list_documents"),
        page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, page }) => text(await readText(space, name, page ?? 1)),
  );

  return server;
}

const DEVICE_TOKEN = /^Bearer (seyl_mcp_[A-Za-z0-9_-]{43})$/;

export const deviceMcp = new Hono();
// Stateless: every request gets a fresh server + transport (nothing to share between api pods).
deviceMcp.all("/", async (c) => {
  // Browsers always send Origin; MCP clients (OpenCode, OpenWork's engine) don't.
  // (MCP spec: validate Origin → 403.)
  if (c.req.header("origin")) return c.json({ error: "Forbidden" }, 403);
  const token = DEVICE_TOKEN.exec(c.req.header("authorization") ?? "")?.[1];
  const owner = token === undefined ? undefined : await deviceOwner(token);
  if (owner === undefined) return c.json({ error: "Unauthorized" }, 401);
  const { id: space } = await personalSpace(owner, { folder: false });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createServer(space).connect(transport);
  return transport.handleRequest(c.req.raw);
});
