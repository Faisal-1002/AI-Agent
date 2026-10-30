// Ai-Agent's document tools for the agent: docs_search_documents, docs_list_documents,
// docs_read_document (OpenCode names custom tools <file>_<export>).
//
// OpenCode loads this file as "custom tools" from its config folder (XDG_CONFIG_HOME/opencode/tools;
// in the image a root-owned folder the agent can neither read nor change). Unlike an MCP server,
// a custom tool is told by OpenCode itself WHICH conversation is calling (context.sessionID) and
// in which folder (context.directory) — the model can't set either. The api looks up who owns
// that conversation and answers from that person's library only (server/tools.ts).
//
// Plain JavaScript with no imports, so it needs no packages. (OpenCode npm-installs its plugin
// package into any config folder it can WRITE to; the image's copy is root-owned, so nothing is
// installed there.) Arguments are written as JSON Schema (OpenCode's legacy form, where every
// argument is required); OpenCode doesn't validate them, so the api does.

const URL = process.env.AI_AGENT_DOCS_URL ?? "http://127.0.0.1:3001/internal/docs";
const TOKEN = process.env.AI_AGENT_MCP_TOKEN ?? "";

async function call(op, args, context) {
  const res = await fetch(`${URL}/${op}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionID: context.sessionID, directory: context.directory, args }),
    signal: context.abort,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? `The document tools are unavailable (HTTP ${res.status}).`);
  return body.text;
}

export const search_documents = {
  description:
    "Search the user's uploaded documents by meaning (semantic search) and return the most relevant passages with their document names. Use this for any question that the user's documents might answer. Phrase the query as a question or a description of what you're looking for.",
  args: { query: { type: "string", description: "What to look for, in natural language" } },
  execute: (args, context) => call("search", args, context),
};

export const list_documents = {
  description: "List the documents the user has uploaded (name, type, size, whether they're searchable yet).",
  args: {},
  execute: (_args, context) => call("list", {}, context),
};

export const read_document = {
  description:
    "Read the full text of one uploaded document, a page at a time. Use it to summarize a document or when search results aren't enough.",
  args: {
    name: { type: "string", description: "The document's file name, as shown by docs_list_documents" },
    page: { type: "integer", minimum: 1, description: "Page number: 1 for the first page" },
  },
  execute: (args, context) => call("read", args, context),
};
