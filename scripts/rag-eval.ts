// Measures "chat with your documents" on a fixed, fictional test library (evals/rag/).
//
//   npm run rag:eval                             # retrieval: does search return the right passage? (~1 min)
//   npm run rag:eval -- --answers                # end to end: ask the real agent every question (slow)
//   npm run rag:eval -- --answers --kind deep    # only some questions (--kind, --only id,id, --limit N)
//   npm run rag:eval -- --answers --runs 3       # ask each question 3 times and average (the agent samples)
//   npm run rag:eval -- --label hybrid           # save the results as evals/results/<time>-hybrid-<mode>.json
//   npm run rag:eval -- --compare A.json B.json  # what changed between two saved runs
//   npm run rag:eval -- --regrade A.json         # grade a saved answers run again (after a grading fix)
//
// Retrieval runs the search code from THIS checkout (server/documents.ts) against the cluster's
// database and gateway (its own port-forwards), in a temporary space that is deleted afterwards:
// change the code, run it again, compare — no image rebuild needed. It searches with the user's
// question as typed; the agent writes its own queries, which the answer eval covers.
//
// Answers go through the deployed app as a temporary user: upload the library, ask each question
// in a fresh conversation, grade the reply. Rebuild and deploy first to measure a code change.
//
// The data: evals/rag/corpus/ (files named *.pdf.txt are turned into PDFs) and
// evals/rag/questions.json — each question with exact evidence quotes, regexes a correct answer
// must (not) match, and a kind (fact, keyword, paraphrase, multi, table, version, deep, arabic,
// cross-lingual, unanswerable).

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askAgent } from "./lib/ask-agent.js";
import { api, kubectl, temporaryUsers, waitFor } from "./lib/live.js";
import { textToPdf } from "./lib/pdf.js";
import { portForward } from "./lib/port-forward.js";

type Evidence = { document: string; quote: string };
type Question = {
  id: string;
  question: string;
  lang: "en" | "ar";
  kind: string;
  evidence: Evidence[];
  answer: string;
  mustInclude: string[];
  mustNotInclude: string[];
};
type Summary = Record<string, number>;
type Saved = {
  mode: "retrieval" | "answers";
  label: string;
  commit: string;
  at: string;
  config: Record<string, unknown>; // the search settings and a fingerprint of the search code
  valid: boolean; // false if any search fell back from reranking: the numbers aren't the reranker's
  skipped: { id: string; why: string }[];
  summary: Summary;
  byKind: Record<string, Summary>;
  results: Record<string, unknown>[];
};

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "evals", "rag");
const RESULTS = path.join(ROOT, "evals", "results");

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const mode = flag("answers") || flag("regrade") ? "answers" : "retrieval";
const only = option("only")?.split(",");
const kinds = option("kind")?.split(",");
const limit = option("limit") ? Number(option("limit")) : Infinity;
const label = option("label") ?? "run";
const runs = Math.max(1, Number.parseInt(option("runs") ?? "1", 10) || 1);

const questions = (JSON.parse(readFileSync(path.join(DATA, "questions.json"), "utf8")) as Question[])
  .filter((q) => (!only || only.includes(q.id)) && (!kinds || kinds.includes(q.kind)))
  .slice(0, limit);

// The library: name as uploaded → bytes.
const corpus: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = readdirSync(path.join(DATA, "corpus"))
  .sort()
  .map((file) => {
    const bytes = readFileSync(path.join(DATA, "corpus", file));
    return file.endsWith(".pdf.txt") ? { name: file.slice(0, -4), bytes: textToPdf(bytes.toString("utf8")) } : { name: file, bytes: new Uint8Array(bytes) };
  });

// Text compared the same way on both sides: Unicode-normalized, lower case, single spaces,
// common HTML entities decoded (the HTML extractor keeps them).
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number) => (Number.isNaN(x) ? "  –  " : `${(x * 100).toFixed(0).padStart(3)}%`);

function groupBy<T>(items: T[], key: (item: T) => string) {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[key(item)] ??= []).push(item);
  return groups;
}

// What decides the numbers: the reranking settings and the search code itself.
function searchConfig(): Record<string, unknown> {
  const code = createHash("sha256");
  for (const f of ["server/documents.ts", "server/chunk.ts", "server/tools.ts"]) code.update(readFileSync(path.join(ROOT, f)));
  return {
    rerank: process.env.AI_AGENT_RERANK === "off" ? "off" : "on",
    rerankModel: process.env.AI_AGENT_RERANK_MODEL ?? "qwen3-reranker",
    rerankCandidates: process.env.AI_AGENT_RERANK_CANDIDATES ?? "30",
    rerankUrl: process.env.AI_AGENT_RERANK_URL ?? "(the gateway)",
    searchCode: code.digest("hex").slice(0, 12),
  };
}

function save(saved: Omit<Saved, "commit" | "at" | "label" | "mode">) {
  mkdirSync(RESULTS, { recursive: true });
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", ROOT, "describe", "--always", "--dirty"], { encoding: "utf8" }).trim();
  } catch {}
  const at = new Date().toISOString();
  const file = path.join(RESULTS, `${at.slice(0, 16).replace(/[:T]/g, "-")}-${label}-${mode}.json`);
  writeFileSync(file, JSON.stringify({ mode, label, commit, at, ...saved }, null, 2));
  console.log(`\nsaved ${path.relative(ROOT, file)}`);
}

// ── Retrieval ───────────────────────────────────────────────────────────────

async function retrieval() {
  // The app's code reads its connection settings when it's imported: forward first, then import.
  const forwards: { close: () => void }[] = [];
  if (!process.env.LLM_GATEWAY_URL) {
    const gateway = await portForward("litellm", 4000);
    forwards.push(gateway);
    process.env.LLM_GATEWAY_URL = `http://127.0.0.1:${gateway.port}`;
  }
  if (!process.env.AI_AGENT_DB_PORT) {
    const db = await portForward("db", 5432);
    forwards.push(db);
    process.env.AI_AGENT_DB_HOST = "127.0.0.1";
    process.env.AI_AGENT_DB_PORT = String(db.port);
  }
  const { addDocument, rerankStats, searchDocuments } = await import("../server/documents.js");
  const { migrate, sql } = await import("../server/db.js");
  await migrate(); // this checkout's schema, as the api would create it on deploy
  console.log(`reranking: ${process.env.AI_AGENT_RERANK === "off" ? "off" : `${process.env.AI_AGENT_RERANK_MODEL ?? "qwen3-reranker"}, ${process.env.AI_AGENT_RERANK_CANDIDATES ?? 30} candidates`}`);

  // A space of its own (kind "eval", no owner can sign in to it); leftovers of a crashed run go first.
  await sql`DELETE FROM spaces WHERE kind = 'eval' AND created_at < now() - interval '1 hour'`;
  const [{ id: space }] = await sql<{ id: string }[]>`INSERT INTO spaces (kind, owner_sub) VALUES ('eval', ${`rag-eval-${randomBytes(4).toString("hex")}`}) RETURNING id`;
  try {
    const started = Date.now();
    for (const doc of corpus) await addDocument(new File([doc.bytes], doc.name), space, "rag-eval");
    const indexed = await waitFor(async () => {
      const [{ pending }] = await sql<{ pending: number }[]>`SELECT count(*)::int AS pending FROM documents WHERE space_id = ${space} AND status = 'indexing'`;
      return pending === 0;
    }, 600);
    if (!indexed) throw new Error("indexing didn't finish in 10 minutes");
    const docs = await sql<{ name: string; status: string; error: string | null; content: string; chunk_count: number }[]>`
      SELECT name, status, error, content, chunk_count FROM documents WHERE space_id = ${space}`;
    for (const d of docs.filter((d) => d.status !== "ready")) console.log(`! ${d.name}: ${d.error}`);
    const chunks = docs.reduce((n, d) => n + d.chunk_count, 0);
    console.log(`indexed ${docs.length} documents (${chunks} passages) in ${((Date.now() - started) / 1000).toFixed(1)}s`);

    // Evidence must survive text extraction AND fit in one passage, or the question tests the data
    // (or the chunking), not the search. Those are skipped, and listed in the saved run.
    const text = new Map(docs.map((d) => [d.name, normalize(d.content)]));
    const passages = groupBy(
      (await sql<{ name: string; content: string }[]>`SELECT d.name, c.content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.space_id = ${space}`).map((c) => ({ name: c.name, text: normalize(c.content) })),
      (c) => c.name,
    );
    const skipped: { id: string; why: string }[] = [];
    for (const q of questions) {
      for (const e of q.evidence) {
        const quote = normalize(e.quote);
        const why = !text.get(e.document)?.includes(quote) ? `evidence not in the extracted text of ${e.document}` : !passages[e.document]?.some((p) => p.text.includes(quote)) ? `evidence split across two passages of ${e.document}` : undefined;
        if (why && !skipped.some((x) => x.id === q.id)) skipped.push({ id: q.id, why });
      }
    }
    for (const x of skipped) console.log(`! ${x.id}: ${x.why} — skipped`);
    const broken = questions.filter((q) => skipped.some((x) => x.id === q.id));

    const results = [];
    for (const q of questions.filter((q) => !broken.includes(q))) {
      const t = Date.now();
      const hits = await searchDocuments(q.question, space, 10);
      const ms = Date.now() - t;
      const ranks = q.evidence.map((e) => {
        const i = hits.findIndex((h) => h.document === e.document && normalize(h.content).includes(normalize(e.quote)));
        return i < 0 ? Infinity : i + 1;
      });
      const best = Math.min(...ranks);
      const top5Docs = new Set(hits.slice(0, 5).map((h) => h.document));
      results.push({
        id: q.id,
        kind: q.kind,
        lang: q.lang,
        answerable: q.evidence.length > 0,
        ranks: ranks.map((r) => (r === Infinity ? null : r)),
        hit1: best <= 1 ? 1 : 0,
        hit5: best <= 5 ? 1 : 0,
        recall5: ranks.length ? ranks.filter((r) => r <= 5).length / ranks.length : 0,
        mrr: best <= 10 ? 1 / best : 0,
        doc5: q.evidence.every((e) => top5Docs.has(e.document)) ? 1 : 0,
        topScore: hits[0]?.score ?? 0,
        ms,
        top: hits.slice(0, 3).map((h) => `${h.document}#${h.position + 1} (${h.score.toFixed(2)})`),
      });
    }

    const answerable = results.filter((r) => r.answerable);
    const summarize = (rs: typeof answerable): Summary => ({
      n: rs.length,
      hit1: mean(rs.map((r) => r.hit1)),
      hit5: mean(rs.map((r) => r.hit5)),
      recall5: mean(rs.map((r) => r.recall5)),
      mrr: mean(rs.map((r) => r.mrr)),
      doc5: mean(rs.map((r) => r.doc5)),
    });
    const summary: Summary = { ...summarize(answerable), msMedian: [...results.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(results.length / 2)] ?? NaN };
    const byKind = Object.fromEntries(Object.entries(groupBy(answerable, (r) => r.kind)).map(([k, rs]) => [k, summarize(rs)]));
    const byLang = Object.fromEntries(Object.entries(groupBy(answerable, (r) => r.lang)).map(([k, rs]) => [`lang:${k}`, summarize(rs)]));

    console.log("\n              n   hit@1  hit@5  recall@5  MRR   doc@5");
    for (const [name, s] of [...Object.entries(byKind).sort(), ...Object.entries(byLang), ["ALL", summary] as const]) {
      console.log(`${name.padEnd(13)} ${String(s.n).padStart(2)}   ${pct(s.hit1)}  ${pct(s.hit5)}   ${pct(s.recall5)}   ${s.mrr.toFixed(2)}  ${pct(s.doc5)}`);
    }
    const unanswerable = results.filter((r) => !r.answerable);
    console.log(
      `\ntop score: answerable ${mean(answerable.map((r) => r.topScore)).toFixed(3)} on average, unanswerable ${mean(unanswerable.map((r) => r.topScore)).toFixed(3)} (could a threshold tell them apart?) · median search ${summary.msMedian} ms`,
    );
    const misses = answerable.filter((r) => r.recall5 < 1);
    if (misses.length) {
      console.log(`\nnot fully found in the top 5 (${misses.length}):`);
      for (const r of misses) console.log(`  ${r.id.padEnd(7)} ${r.kind.padEnd(13)} ranks ${JSON.stringify(r.ranks)} · got ${r.top.join(" | ")}`);
    }
    const valid = rerankStats.fallbacks === 0;
    if (!valid) console.log(`\n! ${rerankStats.fallbacks} of ${results.length} searches fell back to the search order — NOT a reranker measurement (see the warnings above)`);
    save({ summary, byKind: { ...byKind, ...byLang }, results, skipped, valid, config: { ...searchConfig(), ...rerankStats } });
  } finally {
    await sql`DELETE FROM spaces WHERE id = ${space}`; // documents and passages go with it
    await sql.end();
    for (const f of forwards) f.close();
  }
}

// ── Answers ─────────────────────────────────────────────────────────────────

// A reply that says the documents don't have it (English or Arabic). A quick check first; when it
// doesn't match, a judge model reads the reply (there are many ways to say "it isn't there").
const NOT_FOUND =
  /\b(not (found|mentioned|included|specified|stated|listed|covered|provided|given|available|in (the|your) documents?)|no (information|mention|details?|record)|no\b[^.]{0,60}\b(provided|given|listed|mentioned|stated|available|specified|found)|(doesn't|does not|don't|do not|didn't|did not) (say|mention|include|specify|contain|have|state|list|cover|give|provide)|(couldn't|could not|can't|cannot|wasn't able to|was not able to) find|(isn't|is not|aren't|are not) (mentioned|specified|listed|provided|given|available|in))\b|لا (توجد|يوجد|تذكر|يذكر|تتضمن|يتضمن|تحتوي|يحتوي)|لم (أجد|اجد|تذكر|يذكر|يتم|ترد|يرد)|غير (مذكور|موجود|متوفر)|ليس(ت)? (مذكور|موجود)/i;

const matches = (source: string, text: string) => new RegExp(source, "iu").test(text);
const plain = (text: string) => text.normalize("NFKC").replace(/[\u2018\u2019\u02bc]/g, "'");

const NOT_FOUND_MORE = /\b(did not|didn't) find|\bnothing (about|on|regarding)\b|\bnone of the (documents|files|passages)\b|\bunable to find\b|\b(isn't|is not|aren't|are not) covered\b|لا تتوفر|ليس هناك|لا تشير/i;

type Judge = (question: string, answer: string) => Promise<boolean>;

// The main model, asked one narrow question with its reasoning off: did the reply say the documents
// don't have it, or did it present an answer as if they did?
async function judge(): Promise<{ judge: Judge; close: () => void }> {
  const gateway = await portForward("litellm", 4000);
  const ask: Judge = async (question, answer) => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.LITELLM_KEY_API}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.5-9b",
        messages: [
          {
            role: "user",
            content: `A user asked an assistant a question that the user's documents do NOT answer.\n\nQuestion: ${question}\n\nAssistant's reply:\n${answer.slice(0, 4000)}\n\nDid the reply make clear that the documents don't contain this specific information (mentioning related facts is fine), or did it give a specific answer to the question as if the documents said so? Reply with one word: ABSTAINED or ANSWERED.`,
          },
        ],
        max_tokens: 5,
        temperature: 0,
        reasoning_effort: "none",
      }),
    });
    if (!res.ok) throw new Error(`judge: HTTP ${res.status}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return /ABSTAIN/i.test(body.choices[0]?.message.content ?? "");
  };
  return { judge: ask, close: gateway.close };
}

type Graded = { correct: number; cited: boolean | null; missing: string[]; wrong: string[]; judged?: boolean };

async function grade(q: Question, answer: string, ask: Judge): Promise<Graded> {
  const answerable = q.evidence.length > 0;
  const missing = q.mustInclude.filter((re) => !matches(re, answer));
  const wrong = q.mustNotInclude.filter((re) => matches(re, answer));
  const names = [...new Set(q.evidence.map((e) => e.document))];
  const cited = answerable ? names.some((n) => answer.toLowerCase().includes(n.toLowerCase()) || answer.toLowerCase().includes(n.replace(/\.[^.]+$/, "").toLowerCase())) : null;
  if (!answer || wrong.length) return { correct: 0, cited, missing, wrong };
  if (answerable) return { correct: missing.length === 0 ? 1 : 0, cited, missing, wrong };
  if (NOT_FOUND.test(plain(answer)) || NOT_FOUND_MORE.test(plain(answer))) return { correct: 1, cited, missing, wrong };
  return { correct: (await ask(q.question, answer)) ? 1 : 0, cited, missing, wrong, judged: true };
}

type AnswerResult = Graded & { id: string; run?: number; kind: string; lang: string; searched: number; seconds: number; tools: string[]; error?: string; answer: string };

function line(r: AnswerResult) {
  const why = !r.correct && !r.error ? `missing ${JSON.stringify(r.missing)}${r.wrong.length ? ` wrong ${JSON.stringify(r.wrong)}` : ""} · ${r.answer.replace(/\s+/g, " ").slice(0, 160)}` : "";
  return `${r.correct ? "✓" : "✗"} ${r.id.padEnd(7)} ${r.kind.padEnd(13)} ${r.seconds.toFixed(1).padStart(5)}s ${r.cited === false ? "(no citation) " : ""}${r.judged ? "(judged) " : ""}${r.error ? `error: ${r.error}` : ""}${why}`;
}

function report(results: AnswerResult[], extra: Pick<Saved, "valid" | "config">) {
  const summarize = (rs: AnswerResult[]): Summary => ({
    n: rs.length,
    correct: mean(rs.map((r) => r.correct)),
    cited: mean(rs.filter((r) => r.cited !== null).map((r) => (r.cited ? 1 : 0))),
    searched: mean(rs.map((r) => r.searched)),
    seconds: mean(rs.map((r) => r.seconds)),
  });
  const summary = summarize(results);
  const byKind = Object.fromEntries(Object.entries(groupBy(results, (r) => r.kind)).map(([k, rs]) => [k, summarize(rs)]));
  const byLang = Object.fromEntries(Object.entries(groupBy(results, (r) => r.lang)).map(([k, rs]) => [`lang:${k}`, summarize(rs)]));
  console.log("\n              n   correct  cited  searched  seconds");
  for (const [name, s] of [...Object.entries(byKind).sort(), ...Object.entries(byLang), ["ALL", summary] as const]) {
    console.log(`${name.padEnd(13)} ${String(s.n).padStart(2)}    ${pct(s.correct)}   ${pct(s.cited)}    ${pct(s.searched)}    ${s.seconds.toFixed(1)}`);
  }
  if (!extra.valid) console.log(`\n! the api fell back to the search order ${extra.config.fallbacks} times — NOT a reranker measurement`);
  save({ summary, byKind: { ...byKind, ...byLang }, results, skipped: [], ...extra });
}

// The deployed api logs every fallback ("reranking failed"); count them since the run started.
function apiFallbacks(since: number): number {
  try {
    const seconds = Math.ceil((Date.now() - since) / 1000) + 5;
    return kubectl("logs", "-l", "app=api", "--since", `${seconds}s`, "--tail", "-1").split("\n").filter((l) => l.includes("reranking failed")).length;
  } catch {
    return -1; // unknown
  }
}

async function answers() {
  const users = await temporaryUsers();
  const { judge: ask, close } = await judge();
  const interrupted = () => void Promise.allSettled([users.cleanup()]).then(() => process.exit(130));
  process.once("SIGINT", interrupted).once("SIGTERM", interrupted);
  const started = Date.now();
  try {
    const { session } = await users.create("rag-eval");
    const call = api(session);
    for (const doc of corpus) {
      const form = new FormData();
      form.append("file", new File([doc.bytes], doc.name));
      await call("/documents", { method: "POST", body: form });
    }
    const ready = await waitFor(async () => {
      const docs = await call<{ name: string; status: string; error?: string }[]>("/documents");
      return docs.every((d) => d.status !== "indexing") && docs;
    }, 600);
    if (!ready) throw new Error("indexing didn't finish in 10 minutes");
    for (const d of ready.filter((d) => d.status !== "ready")) console.log(`! ${d.name}: ${d.error}`);
    console.log(`uploaded ${ready.length} documents; asking ${questions.length} questions${runs > 1 ? `, ${runs} times each` : ""}…\n`);

    // The agent samples: whether it searches at all varies from run to run, so one run of 70 moves
    // by a few points on its own. --runs N asks everything N times; the numbers are the average.
    const results: AnswerResult[] = [];
    for (let n = 1; n <= runs; n++) {
      for (const q of questions) {
        const run = await askAgent(call, q.question);
        const searched = run.tools.some((t) => t.startsWith("docs_search_documents") || t.startsWith("docs_read_document"));
        const r: AnswerResult = { id: q.id, run: n, kind: q.kind, lang: q.lang, ...(await grade(q, run.answer, ask)), searched: searched ? 1 : 0, seconds: run.seconds, tools: run.tools, error: run.error, answer: run.answer };
        results.push(r);
        console.log(line(r));
      }
    }
    const fallbacks = apiFallbacks(started);
    report(results, { valid: fallbacks === 0, config: { deployed: true, ...searchConfig(), fallbacks } });
  } finally {
    close();
    await users.cleanup();
  }
}

// Grade saved answers again (after a grading fix), so every run is scored the same way.
async function regrade(file: string) {
  const saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
  if (saved.mode !== "answers") throw new Error("--regrade takes an answers run");
  const { judge: ask, close } = await judge();
  try {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const results: AnswerResult[] = [];
    for (const old of saved.results as AnswerResult[]) {
      const q = byId.get(old.id);
      if (!q) continue;
      const r: AnswerResult = { ...old, kind: q.kind, judged: undefined, ...(await grade(q, old.answer, ask)) };
      results.push(r);
      if (r.correct !== old.correct) console.log(`${old.correct ? "✓→✗" : "✗→✓"} ${line(r)}`);
    }
    report(results, { valid: saved.valid ?? true, config: { ...saved.config, regradedFrom: path.basename(file) } });
  } finally {
    close();
  }
}

// ── Compare ─────────────────────────────────────────────────────────────────

function compare(a: Saved, b: Saved) {
  if (a.mode !== b.mode) throw new Error(`Can't compare a ${a.mode} run with an ${b.mode} run`);
  console.log(`A: ${a.label} (${a.commit}, ${a.at})${a.valid === false ? " — INVALID (fell back)" : ""}\nB: ${b.label} (${b.commit}, ${b.at})${b.valid === false ? " — INVALID (fell back)" : ""}`);
  console.log(`questions: A ${a.summary.n}, B ${b.summary.n}`);
  const idsA = new Set(a.results.map((r) => r.id as string));
  const idsB = new Set(b.results.map((r) => r.id as string));
  const onlyA = [...idsA].filter((id) => !idsB.has(id));
  const onlyB = [...idsB].filter((id) => !idsA.has(id));
  if (onlyA.length || onlyB.length) console.log(`! not the same questions — only in A: ${onlyA.join(", ") || "none"}; only in B: ${onlyB.join(", ") || "none"}`);
  console.log("");
  const keys = Object.keys(a.summary).filter((k) => k !== "n");
  console.log(`${"".padEnd(13)} ${keys.map((k) => k.padStart(18)).join("")}`);
  for (const name of [...new Set([...Object.keys(a.byKind), ...Object.keys(b.byKind)])].sort().concat("ALL")) {
    const sa = name === "ALL" ? a.summary : a.byKind[name];
    const sb = name === "ALL" ? b.summary : b.byKind[name];
    if (!sa || !sb) continue;
    const cells = keys.map((k) => {
      const [x, y] = [sa[k], sb[k]];
      const fmt = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? "–" : k === "seconds" || k === "msMedian" || k === "mrr" ? v.toFixed(2) : pct(v).trim());
      return `${fmt(x)} → ${fmt(y)}`.padStart(18);
    });
    console.log(`${name.padEnd(13)} ${cells.join("")}`);
  }
  // Retrieval: the reciprocal rank of the best evidence (a move from 2nd to 1st counts); answers: right or wrong.
  const score = (r: Record<string, unknown>) => Number(r.mrr ?? r.correct);
  // Per question, averaged over runs (--runs N).
  const perQuestion = (rs: Record<string, unknown>[]) => {
    const groups = groupBy(rs, (r) => r.id as string);
    return new Map(Object.entries(groups).map(([id, g]) => [id, mean(g.map(score))]));
  };
  const before = perQuestion(a.results);
  const after = perQuestion(b.results);
  const fixed = [...after].filter(([id, v]) => (before.get(id) ?? 1) < v).map(([id]) => id);
  const broke = [...after].filter(([id, v]) => (before.get(id) ?? 0) > v).map(([id]) => id);
  console.log(`\nbetter: ${fixed.join(", ") || "none"}\nworse:  ${broke.join(", ") || "none"}`);
}

if (option("regrade")) await regrade(option("regrade")!);
else if (flag("compare")) {
  const [a, b] = argv.slice(argv.indexOf("--compare") + 1);
  if (!a || !b) throw new Error("Usage: npm run rag:eval -- --compare A.json B.json");
  compare(JSON.parse(readFileSync(a, "utf8")) as Saved, JSON.parse(readFileSync(b, "utf8")) as Saved);
} else if (mode === "retrieval") await retrieval();
else await answers();
