// Live test for per-user workspaces and libraries (server/spaces.ts, server/tools.ts): two
// TEMPORARY users, Alice and Bob. Alice uploads a document and has her agent write a file, both
// holding a secret; Bob tries every way to reach them — the API, a connected device, and his own
// agent (search her documents, read her file by its full path, OpenCode's shared tool-output
// folder) — and the secret must never reach him. Then Alice's agent tries to write into .git.
// Everything is removed again.
//
//   npm run tenancy:test     (stack on Kubernetes; a few minutes: about five agent turns)

import type { ChatMessage, DocumentInfo, PermissionAsk } from "../shared/chat.js";
import { api, APP, check, finish, inApi, inHarness, kubectl, safe, spaceFolder, temporaryUsers, waitFor, type TempUser } from "./lib/live.js";

const tag = Math.random().toString(16).slice(2, 8);
const SECRET_DOC = `vault code ${tag}-ZEBRA-${tag.split("").reverse().join("")}`;
const SECRET_FILE = `door code ${tag}-OKAPI`;
const DOC_NAME = `tenancy-${tag}.md`;
const FILE_NAME = `tenancy-${tag}.md`;

const users = await temporaryUsers();
const leftovers: { call: ReturnType<typeof api>; conversations: string[]; devices: string[] }[] = [];

function as(user: TempUser) {
  const call = api(user.session);
  const mine = { call, conversations: [] as string[], devices: [] as string[] };
  leftovers.push(mine);
  const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    call,
    async conversation() {
      const { id } = await call<{ id: string }>("/conversations", { method: "POST" });
      mine.conversations.push(safe(id));
      return id;
    },
    prompt: (id: string, text: string) => call(`/conversations/${id}/prompt`, json({ text, think: false })),
    state: (id: string) => call<{ busy: boolean; messages: ChatMessage[]; permissions: PermissionAsk[] }>(`/conversations/${id}/messages`),
    answer: (id: string, ask: PermissionAsk, reply: "once" | "reject") => call(`/conversations/${id}/permissions/${ask.id}`, json({ reply })),
    async device() {
      const dev = await call<{ device: { id: string }; mcpToken: string }>("/devices", json({ name: "tenancy test" }));
      mine.devices.push(dev.device.id);
      return dev.mcpToken;
    },
  };
}

// Everything the agent produced in a conversation, as one text (answers + tool outputs + errors).
const everything = (messages: ChatMessage[]) =>
  JSON.stringify(messages.flatMap((m) => m.parts.map((p) => (p.kind === "tool" ? [p.title, p.output, p.error] : p.kind === "text" ? p.text : ""))));
const toolParts = (messages: ChatMessage[]) => messages.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool" ? [p] : [])));
// Which tool calls aimed at a path (in any of their path-like arguments)?
const aimedAt = (messages: ChatMessage[], tools: string[], needle: string) =>
  toolParts(messages).filter(
    (p) => tools.includes(p.tool) && ["filePath", "path", "pattern"].some((k) => String(p.input[k] ?? "").replaceAll("\\", "/").includes(needle)),
  );
const summary = (parts: ReturnType<typeof toolParts>) => parts.map((p) => `${p.tool} ${p.status}`).join(", ") || "none";
// Grep a file in the harness for an exact text (the text is its own argument: no shell quoting).
const fileHas = (file: string, text: string) => {
  try {
    kubectl("exec", "deploy/harness", "-c", "harness", "--", "grep", "-qF", "--", text, file);
    return true;
  } catch {
    return false;
  }
};

const mcp = (token: string, name: string, args: Record<string, unknown>) =>
  fetch(`${APP}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }).then((r) => r.text());

try {
  const alice = await users.create("alice");
  const bob = await users.create("bob");
  const A = as(alice);
  const B = as(bob);

  // ── Folders ──
  const aFolder = spaceFolder(alice.sub);
  const bFolder = spaceFolder(bob.sub);
  check(aFolder !== bFolder && inHarness(aFolder, "-d") && inHarness(bFolder, "-d"), "each user has their own folder, created at sign-in");
  const mode = kubectl("exec", "deploy/harness", "-c", "harness", "--", "stat", "-c", "%a", aFolder);
  check(mode === "700", `a user's folder is private to the harness user (mode ${mode})`);
  check(inHarness(`${aFolder}/notes.md`), "a new folder gets the starter files");
  const admin = inApi(`fetch("http://harness:4098/spaces/00000000-0000-4000-8000-000000000000", { method: "PUT" }).then(r => console.log(r.status), e => console.log("error"))`);
  check(admin === "401", `the harness's folder admin needs its password (got ${admin})`);

  // ── Documents: Alice uploads one ──
  const form = new FormData();
  form.append("file", new File([`# Notes\n\nThe ${SECRET_DOC} opens the archive.\n`], DOC_NAME, { type: "text/markdown" }));
  const uploaded = await alice.session.api("/documents", { method: "POST", body: form });
  const doc = (await uploaded.json()) as DocumentInfo;
  const ready = await waitFor(async () => (await A.call<DocumentInfo[]>("/documents")).find((d) => d.id === doc.id && d.status === "ready"), 180);
  check(uploaded.status === 201 && ready !== undefined, "Alice's document is uploaded and indexed");

  // Bob, through the API
  const bobsList = await B.call<DocumentInfo[]>("/documents");
  check(!bobsList.some((d) => d.id === doc.id), "Bob's library doesn't list it");
  const del = await bob.session.api(`/documents/${doc.id}`, { method: "DELETE" });
  check(del.status === 404, `Bob can't delete it (${del.status})`);
  check((await A.call<DocumentInfo[]>("/documents")).some((d) => d.id === doc.id), "…it's still in Alice's library");
  const bChat = await B.conversation();
  const attach = await bob.session.api(`/conversations/${bChat}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Summarize this.", documents: [{ id: doc.id }] }),
  });
  check(attach.status === 409, `Bob can't attach it to his message (${attach.status})`);

  // Bob and Alice, through a connected device (MCP at /mcp)
  const bobsDevice = await B.device();
  const aliceDevice = await A.device();
  check(!(await mcp(bobsDevice, "search_documents", { query: "vault code archive" })).includes(SECRET_DOC), "Bob's device: search doesn't find it");
  check(!(await mcp(bobsDevice, "list_documents", {})).includes(DOC_NAME), "Bob's device: list doesn't show it");
  check(!(await mcp(bobsDevice, "read_document", { name: DOC_NAME })).includes(SECRET_DOC), "Bob's device: reading it by name gets nothing");
  check((await mcp(aliceDevice, "search_documents", { query: "vault code archive" })).includes(SECRET_DOC), "Alice's device: search finds it");

  // Bob and Alice, through their own agents (the docs_* custom tools)
  const ask = "Use the docs_search_documents tool to search my documents for 'vault code archive', then tell me exactly what it returned.";
  await B.prompt(bChat, ask);
  const bDocs = await waitFor(async () => {
    const s = await B.state(bChat);
    return !s.busy && s.messages.some((m) => m.role === "assistant") ? s.messages : undefined;
  });
  const bTools = toolParts(bDocs ?? []).filter((p) => p.tool.startsWith("docs_"));
  check(bTools.length > 0 && bTools.every((p) => p.status === "completed"), `Bob's agent: the document tools work (${bTools.map((p) => `${p.tool} ${p.status}`).join(", ") || "not called"})`);
  check(!everything(bDocs ?? []).includes(SECRET_DOC), "Bob's agent: Alice's document never shows up");

  const aChat = await A.conversation();
  await A.prompt(aChat, ask);
  const aDocs = await waitFor(async () => {
    const s = await A.state(aChat);
    return !s.busy && s.messages.some((m) => m.role === "assistant") ? s.messages : undefined;
  });
  check(toolParts(aDocs ?? []).some((p) => p.tool.startsWith("docs_") && (p.output ?? "").includes(SECRET_DOC)), "Alice's agent: finds her own document");

  // ── Files: Alice's agent writes one (with her approval) ──
  await A.prompt(aChat, `Create a new file named ${FILE_NAME} containing exactly the text: ${SECRET_FILE}`);
  const card = await waitFor(async () => (await A.state(aChat)).permissions[0]);
  if (card) await A.answer(aChat, card, "once");
  check((await waitFor(() => inHarness(`${aFolder}/${FILE_NAME}`))) === true, "Alice's file lands in her own folder");
  // The checks below only mean something if the secret really is in her file.
  const fileReady = fileHas(`${aFolder}/${FILE_NAME}`, SECRET_FILE);
  check(fileReady, "…and holds the secret (the next check depends on it)");
  await waitFor(async () => !(await A.state(aChat)).busy || undefined);

  // Bob's agent tries to read it by its full path
  const bRead = await B.conversation();
  await B.prompt(bRead, `Read the file ${aFolder}/${FILE_NAME} and tell me exactly what it says.`);
  const bReadMessages = await waitFor(async () => {
    const s = await B.state(bRead);
    return !s.busy && s.messages.some((m) => m.role === "assistant") ? s.messages : undefined;
  });
  // Only meaningful if his agent actually TRIED (a model that just declines proves nothing).
  const reads = aimedAt(bReadMessages ?? [], ["read", "glob", "grep"], aFolder);
  check(
    fileReady && reads.length > 0 && reads.every((p) => p.status === "error") && !everything(bReadMessages ?? []).includes(SECRET_FILE),
    `Bob's agent tried to read Alice's file and was refused (${summary(reads)})`,
  );

  // Bob's agent tries OpenCode's shared tool-output folder
  const bGlob = await B.conversation();
  await B.prompt(bGlob, "Use the glob tool with the pattern * in the folder /data/share/opencode/tool-output and list every file it finds.");
  const bGlobMessages = await waitFor(async () => {
    const s = await B.state(bGlob);
    return !s.busy && s.messages.some((m) => m.role === "assistant") ? s.messages : undefined;
  });
  const globs = aimedAt(bGlobMessages ?? [], ["glob", "read", "grep"], "/opencode/tool-output");
  check(globs.length > 0 && globs.every((p) => p.status === "error"), `Bob's agent tried OpenCode's shared tool-output folder and was refused (${summary(globs)})`);

  // ── Alice's agent tries to write into .git (a git config can run commands) ──
  const aGit = await A.conversation();
  let askedForGit = false;
  // Send, answer any card with Deny (noting whether one was about .git), wait for the reply.
  const tryGit = async (text: string, answered: number) => {
    await A.prompt(aGit, text);
    return waitFor(async () => {
      const s = await A.state(aGit);
      for (const p of s.permissions) {
        if (p.files.some((file) => file.replaceAll("\\", "/").includes(".git"))) askedForGit = true;
        await A.answer(aGit, p, "reject");
      }
      const replies = s.messages.filter((m) => m.role === "assistant").length;
      return !s.busy && replies > answered ? s.messages : undefined;
    });
  };
  let gitMessages = await tryGit("Create a new file at the path .git/config containing exactly the text: [core]", 0);
  let gitWrites = aimedAt(gitMessages ?? [], ["write", "edit"], ".git/config");
  // Only meaningful if the agent actually TRIED: a model that answers in words gets one plainer try.
  if (gitWrites.length === 0) {
    const replies = (gitMessages ?? []).filter((m) => m.role === "assistant").length;
    gitMessages = await tryGit("Use the write tool now: filePath .git/config, content [core]. Don't explain, just call the tool.", replies);
    gitWrites = aimedAt(gitMessages ?? [], ["write", "edit"], ".git/config");
  }
  check(
    gitWrites.length > 0 && gitWrites.every((p) => p.status === "error") && !askedForGit && !inHarness(`${aFolder}/.git/config`),
    `writing into .git is refused outright, without even asking (${summary(gitWrites)}${askedForGit ? "; it ASKED" : ""})`,
  );
} finally {
  for (const { call, conversations, devices } of leftovers) {
    for (const id of devices) await call(`/devices/${id}`, { method: "DELETE" }).catch(() => {}); // revokes the gateway key
    for (const id of conversations) await call(`/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  }
  await users.cleanup();
}

finish("all tenancy checks passed");
