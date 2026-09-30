import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { listDocuments, readDocument, searchDocuments } from "./documents.js";

// seyl-ai's MCP server: document tools for the agent.
//
// MCP (Model Context Protocol) is the open standard for giving agents tools. OpenCode
// connects to this endpoint (config `mcp.docs` in server/opencode.ts) and offers these
// tools to the model as docs_search_documents, docs_list_documents, docs_read_document.
// Any other MCP client (Claude, Cursor, …) could use them the same way.
//
// Mounted at /mcp — NOT under /api — so nginx never exposes it to browsers; only the
// harness reaches it, and it must send the shared token (SEYL_MCP_TOKEN).

const TOKEN = process.env.SEYL_MCP_TOKEN;

function createServer(): McpServer {
  const server = new McpServer({ name: "seyl-docs", version: "1.0.0" });

  server.registerTool(
    "search_documents",
    {
      description:
        "Search the user's uploaded documents by meaning (semantic search) and return the most relevant passages with their document names. Use this for any question that the user's documents might answer. Phrase the query as a question or a description of what you're looking for.",
      inputSchema: {
        query: z.string().min(2).describe("What to look for, in natural language"),
        limit: z.number().int().min(1).max(10).optional().describe("How many passages to return (default 5)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const hits = await searchDocuments(query, limit ?? 5);
      const text = hits.length
        ? hits.map((h, i) => `[${i + 1}] ${h.document} — passage ${h.position + 1} (relevance ${h.score.toFixed(2)})\n${h.content}`).join("\n\n---\n\n")
        : "No documents have been uploaded yet, or nothing matched.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "list_documents",
    {
      description: "List the documents the user has uploaded (name, type, size, whether they're searchable yet).",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const docs = await listDocuments();
      const text = docs.length
        ? docs.map((d) => `- ${d.name} (${d.type}, ${Math.ceil(d.size / 1024)} KB, ${d.status}${d.status === "ready" ? `, ${d.chunks} passages` : ""})`).join("\n")
        : "No documents uploaded yet.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "read_document",
    {
      description: "Read the full text of one uploaded document, a page at a time. Use it to summarize a document or when search results aren't enough.",
      inputSchema: {
        name: z.string().describe("The document's file name, as shown by list_documents"),
        page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, page }) => {
      const doc = await readDocument(name, page ?? 1);
      const text = doc ? `${doc.name} — page ${doc.page} of ${doc.pages}\n\n${doc.text}` : `No ready document named "${name}". Use list_documents to see the names.`;
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

export const mcp = new Hono();

// Stateless: every request gets a fresh server + transport (nothing to share between api pods).
mcp.all("/", async (c) => {
  if (!TOKEN || c.req.header("authorization") !== `Bearer ${TOKEN}`) return c.json({ error: "Unauthorized" }, 401);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createServer().connect(transport);
  return transport.handleRequest(c.req.raw);
});
