import mammoth from "mammoth";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { DOCUMENT_TYPES, type AttachedDocument, type DocumentInfo } from "../shared/chat.js";
import { chunkText } from "./chunk.js";
import { sql } from "./db.js";
import { LLM_GATEWAY_URL } from "./opencode.js";
import { UUID } from "./paths.js";

// "Chat with your documents" (RAG): upload → extract text → chunks → embeddings → Postgres
// (pgvector). The agent searches them with its docs tools (server/tools.ts), devices through MCP
// (server/mcp.ts).
//
// Every document belongs to a space (server/spaces.ts) and EVERY query here takes the space it may
// look in: someone else's document behaves exactly like one that doesn't exist.

const API_KEY = process.env.LITELLM_KEY_API;
const EMBEDDING_MODEL = "qwen3-embedding";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const SUPPORTED = DOCUMENT_TYPES;

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

export async function listDocuments(space: string): Promise<DocumentInfo[]> {
  const rows = await sql<Row[]>`
    SELECT id, name, type, size, status, error, chunk_count, created_at FROM documents
    WHERE space_id = ${space} ORDER BY created_at DESC`;
  return rows.map(toInfo);
}

// The attached documents that are ready to read (unknown, someone else's or still-indexing ids
// are left out).
export async function readyDocuments(ids: string[], space: string): Promise<AttachedDocument[]> {
  const valid = ids.filter((id) => UUID.test(id));
  if (valid.length === 0) return [];
  return sql<AttachedDocument[]>`
    SELECT id, name FROM documents WHERE id = ANY(${valid}::uuid[]) AND space_id = ${space} AND status = 'ready'`;
}

export async function deleteDocument(id: string, space: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await sql`DELETE FROM documents WHERE id = ${id} AND space_id = ${space} RETURNING id`; // chunks go too (ON DELETE CASCADE)
  return rows.length > 0;
}

// A file name as it's shown to people and to the model: no control characters (newlines
// could fake extra lines in a prompt), whitespace collapsed, at most 200 characters.
export function cleanName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  return clean || "document";
}

// Store the upload and start indexing in the background; returns right away.
export async function addDocument(file: File, space: string, uploadedBy: string): Promise<DocumentInfo> {
  const type = fileType(file.name);
  const [row] = await sql<Row[]>`
    INSERT INTO documents (name, type, size, space_id, uploaded_by)
    VALUES (${cleanName(file.name)}, ${type}, ${file.size}, ${space}, ${uploadedBy})
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

// ── Search & read (used by the docs tools) ───────────────────────────────────

// reranked: the score is the reranker's P(yes) ("does this passage answer the question?");
// otherwise it's the vector similarity (reranking off, or it failed).
export type SearchHit = { document: string; position: number; score: number; content: string; reranked?: boolean };

// Search in two steps (npm run rag:eval measures both; numbers in the README, "Documents"):
//   1. find — the passages closest in MEANING to the question (its embedding vs. theirs): fast,
//      but it compares two summaries, so the best passage is often 2nd or 6th, not 1st;
//   2. rerank — Qwen3-Reranker reads each candidate next to the question and answers "does this
//      passage answer it?"; the probability of "yes" orders them, and becomes the score shown.
// If the reranker fails or is slow, search still answers, in step 1's order (and says so).
const RERANK = process.env.AI_AGENT_RERANK !== "off";
const RERANK_URL = process.env.AI_AGENT_RERANK_URL ?? `${LLM_GATEWAY_URL}/v1`;
const RERANK_MODEL = process.env.AI_AGENT_RERANK_MODEL ?? "qwen3-reranker";
const RERANK_CANDIDATES = positiveInt(process.env.AI_AGENT_RERANK_CANDIDATES, 30, 100);
const RERANK_TIMEOUT_MS = positiveInt(process.env.AI_AGENT_RERANK_TIMEOUT_MS, 10_000, 120_000); // the whole rerank
// Requests in flight: keeps Ollama's queue full. Ollama itself runs them one at a time (~30 ms each
// on the GPU); don't raise OLLAMA_NUM_PARALLEL for this — it also multiplies the 9B's context memory.
const RERANK_PARALLEL = 4;
const RERANK_INSTRUCTION = "Given a question about the user's documents, judge whether the passage answers it";

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

// How many searches were reranked, and how many fell back to the search order (the eval checks it).
export const rerankStats = { reranked: 0, fallbacks: 0 };

type TopLogprob = { token: string; logprob: number };

// P(yes) from the first answer token's alternatives, "yes" vs "no" in any case or spacing;
// undefined when neither word is among them (the reply wasn't a yes/no answer).
export function yesProbability(top: TopLogprob[]): number | undefined {
  const p = (word: string) => top.filter((t) => t.token.trim().toLowerCase() === word).reduce((sum, t) => sum + Math.exp(t.logprob), 0);
  const yes = p("yes");
  const no = p("no");
  return yes + no > 0 ? yes / (yes + no) : undefined;
}

// Document text goes into the reranker's prompt: take out what could pose as the prompt's own
// structure (chat-template tokens like <|im_end|>, and the <Instruct>/<Query>/<Document> labels), so
// a passage can't write itself a "yes". It still only moves passages in the ranking.
export const forReranker = (text: string) => text.replace(/<\|[^|>]*\|>/g, " ").replace(/<\s*(instruct|query|document)\s*>\s*:/gi, "$1:");

async function relevance(query: string, passage: string, signal: AbortSignal): Promise<number> {
  const res = await fetch(`${RERANK_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: RERANK_MODEL,
      // Qwen3-Reranker's own prompt format. reasoning_effort "none" matters: without it Ollama lets
      // the model "think" first, and the first token isn't yes/no (ollama/qwen3-reranker-0.6b.Modelfile).
      messages: [
        { role: "system", content: 'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".' },
        { role: "user", content: `<Instruct>: ${RERANK_INSTRUCTION}\n<Query>: ${forReranker(query)}\n<Document>: ${forReranker(passage)}` },
      ],
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 10,
      reasoning_effort: "none",
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices: { logprobs?: { content?: { top_logprobs: TopLogprob[] }[] } }[] };
  const score = yesProbability(body.choices[0]?.logprobs?.content?.[0]?.top_logprobs ?? []);
  if (score === undefined) throw new Error(`${RERANK_MODEL} didn't answer yes or no (no token probabilities?)`);
  return score;
}

// All or nothing: the first failure (or the deadline) stops the rest, and search falls back.
async function rerank(query: string, hits: SearchHit[], limit: number): Promise<SearchHit[]> {
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(RERANK_TIMEOUT_MS)]);
  const scores = new Array<number>(hits.length);
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(RERANK_PARALLEL, hits.length) }, async () => {
        while (next < hits.length && !signal.aborted) {
          const i = next++;
          scores[i] = await relevance(query, hits[i].content, signal);
        }
      }),
    );
  } catch (err) {
    stop.abort();
    throw signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? new Error(`took over ${RERANK_TIMEOUT_MS} ms`) : err;
  }
  return hits
    .map((hit, i) => ({ ...hit, score: scores[i], reranked: true, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i) // ties keep the search's own order
    .slice(0, limit)
    .map(({ i, ...hit }) => hit);
}

export async function searchDocuments(query: string, space: string, limit = 5): Promise<SearchHit[]> {
  if (!RERANK) return findPassages(query, space, limit);
  const candidates = await findPassages(query, space, Math.max(limit, RERANK_CANDIDATES));
  if (candidates.length <= 1) return candidates;
  try {
    const hits = await rerank(query, candidates, limit);
    rerankStats.reranked++;
    return hits;
  } catch (err) {
    rerankStats.fallbacks++;
    console.warn(`[documents] reranking failed, using the search order: ${(err as Error).message}`);
    return candidates.slice(0, limit);
  }
}

async function findPassages(query: string, space: string, limit: number): Promise<SearchHit[]> {
  const [vector] = await embed([QUERY_INSTRUCTION + query]);
  // <=> is pgvector's cosine distance; 1 − distance = similarity (higher is closer).
  // The HNSW index finds the nearest passages of EVERYONE first and filters by space after: with
  // a small library that can leave too few. Iterative scan (pgvector 0.8) keeps looking until
  // there are enough of this space's own — still in exact order.
  return sql.begin(async (tx) => {
    await tx`SET LOCAL hnsw.iterative_scan = strict_order`;
    return tx<SearchHit[]>`
      SELECT d.name AS document, c.position, 1 - (c.embedding <=> ${toVector(vector)}::vector) AS score, c.content
      FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND d.space_id = ${space}
      ORDER BY c.embedding <=> ${toVector(vector)}::vector
      LIMIT ${limit}`;
  });
}

// A page stays under the 16 KB the agent gets per tool result even in Arabic or Chinese (2–3 bytes
// a character); a longer one would be cut off, with the rest in a file the agent may not open.
const PAGE_CHARS = 5000;

// A document's full text, a page at a time (so a long file doesn't flood the context).
export async function readDocument(name: string, space: string, page = 1) {
  const [doc] = await sql<{ name: string; content: string }[]>`
    SELECT name, content FROM documents
    WHERE space_id = ${space} AND status = 'ready' AND lower(name) = lower(${name})
    ORDER BY created_at DESC LIMIT 1`;
  if (!doc) return undefined;
  const pages = Math.max(1, Math.ceil(doc.content.length / PAGE_CHARS));
  const p = Math.min(Math.max(1, page), pages);
  return { name: doc.name, page: p, pages, text: doc.content.slice((p - 1) * PAGE_CHARS, p * PAGE_CHARS) };
}
