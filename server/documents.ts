import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import type { DocumentInfo } from "../shared/chat.js";
import { chunkText } from "./chunk.js";
import { sql } from "./db.js";
import { LLM_GATEWAY_URL } from "./opencode.js";

// "Chat with your documents" (RAG): upload → extract text → chunks → embeddings → Postgres
// (pgvector). The agent searches them through MCP tools (server/mcp.ts).

const API_KEY = process.env.LITELLM_KEY_API;
const EMBEDDING_MODEL = "qwen3-embedding";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SUPPORTED = ["pdf", "docx", "md", "txt", "csv", "json", "html"];

// Qwen3-Embedding is asymmetric: questions get an instruction, documents don't.
const QUERY_INSTRUCTION = "Instruct: Given a question, retrieve passages from the user's documents that answer it\nQuery: ";

// ── Embeddings (through the gateway) ─────────────────────────────────────────

async function embed(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const res = await fetch(`${LLM_GATEWAY_URL}/v1/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.slice(i, i + 16) }),
    });
    if (!res.ok) throw new Error(`Embedding failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { data } = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    vectors.push(...data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return vectors;
}

// pgvector's text format: "[0.1,0.2,…]"
const toVector = (v: number[]) => `[${v.join(",")}]`;

// ── Text extraction ──────────────────────────────────────────────────────────

export function fileType(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

async function extractText(type: string, bytes: Uint8Array): Promise<string> {
  switch (type) {
    case "pdf": {
      const { text } = await extractPdfText(await getDocumentProxy(bytes), { mergePages: true });
      return text;
    }
    case "docx":
      return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    case "html":
      return new TextDecoder().decode(bytes).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    default:
      return new TextDecoder().decode(bytes);
  }
}

// ── Library ─────────────────────────────────────────────────────────────────

type Row = { id: string; name: string; type: string; size: number; status: DocumentInfo["status"]; error: string | null; chunk_count: number; created_at: Date };
const toInfo = (r: Row): DocumentInfo => ({
  id: r.id,
  name: r.name,
  type: r.type,
  size: r.size,
  status: r.status,
  ...(r.error && { error: r.error }),
  chunks: r.chunk_count,
  createdAt: r.created_at.toISOString(),
});

export async function listDocuments(): Promise<DocumentInfo[]> {
  const rows = await sql<Row[]>`SELECT id, name, type, size, status, error, chunk_count, created_at FROM documents ORDER BY created_at DESC`;
  return rows.map(toInfo);
}

export async function deleteDocument(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM documents WHERE id = ${id} RETURNING id`; // chunks go too (ON DELETE CASCADE)
  return rows.length > 0;
}

// Store the upload and start indexing in the background; returns right away.
export async function addDocument(file: File): Promise<DocumentInfo> {
  const type = fileType(file.name);
  const [row] = await sql<Row[]>`
    INSERT INTO documents (name, type, size) VALUES (${file.name}, ${type}, ${file.size})
    RETURNING id, name, type, size, status, error, chunk_count, created_at`;
  void indexDocument(row.id, type, new Uint8Array(await file.arrayBuffer()));
  return toInfo(row);
}

async function indexDocument(id: string, type: string, bytes: Uint8Array) {
  const started = Date.now();
  try {
    const text = (await extractText(type, bytes)).trim();
    if (!text) throw new Error("No text found (a scanned PDF needs OCR, which isn't supported yet).");
    const chunks = chunkText(text);
    const vectors = await embed(chunks);
    await sql.begin(async (tx) => {
      for (let i = 0; i < chunks.length; i++) {
        await tx`INSERT INTO chunks (document_id, position, content, embedding)
                 VALUES (${id}, ${i}, ${chunks[i]}, ${toVector(vectors[i])}::vector)`;
      }
      await tx`UPDATE documents SET status = 'ready', content = ${text}, chunk_count = ${chunks.length} WHERE id = ${id}`;
    });
    console.log(`[documents] indexed ${id}: ${chunks.length} chunks in ${Date.now() - started} ms`);
  } catch (err) {
    console.error(`[documents] indexing ${id} failed:`, (err as Error).message);
    await sql`UPDATE documents SET status = 'failed', error = ${(err as Error).message.slice(0, 500)} WHERE id = ${id}`.catch(() => {});
  }
}

// ── Search & read (used by the MCP tools) ────────────────────────────────────

export type SearchHit = { document: string; position: number; score: number; content: string };

export async function searchDocuments(query: string, limit = 5): Promise<SearchHit[]> {
  const [vector] = await embed([QUERY_INSTRUCTION + query]);
  // <=> is pgvector's cosine distance; 1 − distance = similarity (higher is closer).
  return sql<SearchHit[]>`
    SELECT d.name AS document, c.position, 1 - (c.embedding <=> ${toVector(vector)}::vector) AS score, c.content
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'ready'
    ORDER BY c.embedding <=> ${toVector(vector)}::vector
    LIMIT ${limit}`;
}

const PAGE_CHARS = 6000;

// A document's full text, a page at a time (so a long file doesn't flood the context).
export async function readDocument(name: string, page = 1) {
  const [doc] = await sql<{ name: string; content: string }[]>`
    SELECT name, content FROM documents WHERE status = 'ready' AND lower(name) = lower(${name}) ORDER BY created_at DESC LIMIT 1`;
  if (!doc) return undefined;
  const pages = Math.max(1, Math.ceil(doc.content.length / PAGE_CHARS));
  const p = Math.min(Math.max(1, page), pages);
  return { name: doc.name, page: p, pages, text: doc.content.slice((p - 1) * PAGE_CHARS, p * PAGE_CHARS) };
}
