// Live test for approvals and the audit log (server/approvals.ts, server/audit.ts). A TEMPORARY
// user asks the agent to create files and answers the approval cards; the test checks who gets
// asked, what lands in the workspace and what the audit log recorded. Everything it creates
// (user, conversations, files) is removed again.
//
//   npm run approvals:test     (stack on Kubernetes; reaches the workspace and database via kubectl)
//
// Uses the model for a few small file edits: a minute or two.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { PermissionAsk, User } from "../shared/chat.js";
import { keycloakAdmin } from "./lib/keycloak-admin.js";
import { Session } from "./lib/session.js";

try {
  process.loadEnvFile();
} catch {}
const APP = process.env.SEYL_PUBLIC_URL ?? "http://localhost:8080";
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

const kubectl = (...args: string[]) => execFileSync("kubectl", ["-n", "seyl-ai", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const psql = (query: string) => kubectl("exec", "deploy/db", "--", "psql", "-U", "seyl", "-d", "seyl", "-v", "ON_ERROR_STOP=1", "-tAc", query);
const inWorkspace = (file: string) => {
  try {
    kubectl("exec", "deploy/harness", "--", "test", "-f", `/workspace/${file}`);
    return true;
  } catch {
    return false;
  }
};
const safe = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`unexpected id: ${id}`);
  return id;
};

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, seconds = 240): Promise<T | undefined> {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; ) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return undefined;
}

// ── Infrastructure checks (no model needed) ──

const anonymous = kubectl("exec", "deploy/api", "--", "node", "-e", "fetch('http://harness:4097/session').then(r => console.log(r.status), e => console.log('error: ' + e.message))");
check(anonymous === "401", `the harness refuses a request without its password (got ${anonymous})`);
const policy = kubectl("logs", "deploy/harness").split("\n").find((line) => line.startsWith("policy check passed")) ?? "";
check(/MCP servers: docs$/.test(policy), `the harness's startup check covers its MCP servers ("${policy}")`);

// ── A temporary user ──

const { url: KC, close } = await keycloakAdmin();
const token = ((await (await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "" }) })).json()) as { access_token: string }).access_token;
const kc = (path: string, init: RequestInit = {}) => fetch(`${KC}/admin/realms/seyl${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
const username = `approvals-${randomBytes(3).toString("hex")}`;
const password = randomBytes(12).toString("base64url") + "-Aa1!";
await kc("/users", { method: "POST", body: JSON.stringify({ username, email: `${username}@seyl.test`, emailVerified: true, firstName: "Approvals", enabled: true }) });
const [{ id: keycloakId }] = (await (await kc(`/users?username=${username}&exact=true`)).json()) as { id: string }[];
await kc(`/users/${keycloakId}/reset-password`, { method: "PUT", body: JSON.stringify({ type: "password", value: password, temporary: false }) });

const session = new Session(APP);
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await session.api(path, init);
  const body = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body?.error ?? ""}`);
  return body as T;
}
const state = (id: string) => call<{ busy: boolean; permissions: PermissionAsk[] }>(`/conversations/${id}/messages`);
const prompt = (id: string, text: string) =>
  call(`/conversations/${id}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, think: false }) });
const answer = (id: string, ask: PermissionAsk, reply: "once" | "always" | "reject") =>
  call(`/conversations/${id}/permissions/${ask.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply }) });
const idle = (id: string) => waitFor(async () => !(await state(id)).busy || undefined);
const createFile = (file: string, content: string) => `Create a new file named ${file} containing exactly the text: ${content}`;

const tag = randomBytes(3).toString("hex");
const files = [1, 2, 3].map((n) => `approvals-test-${tag}-${n}.md`);
const conversations: string[] = [];

try {
  await session.signIn(username, password);
  const { user } = await call<{ user: User }>("/auth/me");
  const sub = safe(user.sub);

  // 1. Chat A asks; "Allow for this chat".
  const a = safe((await call<{ id: string }>("/conversations", { method: "POST" })).id);
  conversations.push(a);
  await prompt(a, createFile(files[0], "one"));
  const first = await waitFor(async () => (await state(a)).permissions[0]);
  check(first?.action === "edit" && first.files.some((f) => f.endsWith(files[0])), `chat A: the first edit asks first (${first?.action} ${first?.files.join(", ")})`);
  // A double-click: two "Allow for this chat" at once. OpenCode takes one; the rule must survive
  // whichever of the two loses (an earlier version could delete it again).
  if (first) {
    const clicks = await Promise.allSettled([answer(a, first, "always"), answer(a, first, "always")]);
    check(clicks.some((c) => c.status === "fulfilled"), `chat A: "Allow for this chat" (double-click: ${clicks.map((c) => (c.status === "fulfilled" ? "ok" : "refused")).join(" + ")})`);
  }
  check((await waitFor(() => inWorkspace(files[0]))) === true, "chat A: approved → the file is in the workspace");
  check(psql(`SELECT count(*) FROM approval_rules WHERE session_id = '${a}'`) === "1", "chat A: the double-click left exactly one rule");
  await idle(a);

  // 2. Same chat, nobody watching (no event stream open, no page polling): the api's watcher
  //    must answer it — before, only an open chat could.
  await prompt(a, createFile(files[1], "two"));
  check((await waitFor(() => inWorkspace(files[1]))) === true, "chat A: the next edit goes through without asking, with no chat open");
  await idle(a);

  // 3. Another chat of the same user: asked again — the approval was for chat A only.
  const b = safe((await call<{ id: string }>("/conversations", { method: "POST" })).id);
  conversations.push(b);
  await prompt(b, createFile(files[2], "three"));
  const other = await waitFor(async () => (await state(b)).permissions[0]);
  check(other !== undefined, "chat B: asked again (\"Allow for this chat\" did not leak to another chat)");
  if (other) await answer(b, other, "reject");
  await idle(b);
  check(!inWorkspace(files[2]), "chat B: denied → no file");

  // 4. The audit log.
  const actions = psql(`SELECT action || ' ' || coalesce(target, '') FROM audit.log WHERE actor = '${sub}' ORDER BY id`).split("\n");
  const count = (line: string) => actions.filter((l) => l === line).length;
  check(count("login ") === 1, "audit: the sign-in");
  check(count(`approval.this_chat ${a}`) === 1, "audit: \"Allow for this chat\" in chat A");
  const autos = count(`approval.auto ${a}`);
  check(autos >= 1, `audit: the automatic approval in chat A (${autos}× — once per request, however many api pods raced)`);
  check(count(`approval.deny ${b}`) === 1, "audit: the denial in chat B");
  check(psql(`SELECT count(*) FROM approval_rules WHERE session_id = '${a}'`) === "1", "chat A still has exactly one approval rule");
  let tampered = true;
  try {
    psql(`UPDATE audit.log SET actor = 'someone else' WHERE actor = '${sub}'`);
  } catch {
    tampered = false;
  }
  check(!tampered, "audit: the api's database user can't change the log");

  // 5. Deleting a chat deletes its rules (and is audited).
  for (const id of conversations.splice(0)) await call(`/conversations/${id}`, { method: "DELETE" });
  check(psql(`SELECT count(*) FROM approval_rules WHERE session_id = '${a}'`) === "0", "deleting chat A deleted its rule");
  check(psql(`SELECT count(*) FROM audit.log WHERE actor = '${sub}' AND action = 'conversation.delete'`) === "2", "audit: both deletions");
} finally {
  for (const id of conversations) await session.api(`/conversations/${id}`, { method: "DELETE" }).catch(() => {});
  kubectl("exec", "deploy/harness", "--", "rm", "-f", ...files.map((f) => `/workspace/${f}`));
  await kc(`/users/${keycloakId}`, { method: "DELETE" });
  close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall approval and audit checks passed");
process.exitCode = failures ? 1 : 0;
