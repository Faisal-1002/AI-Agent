import "./env.js"; // first: .env before any module reads its settings
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { AGENT, client, config, HARNESS_ADMIN_PORT, HARNESS_AUTHORIZATION, HARNESS_USER, OPENCODE_HOSTNAME, OPENCODE_PORT } from "./opencode.js";
import { CONTROL_DIR, LEGACY_WORKSPACE, spaceDir, UUID, WORKSPACE_SEED, WORKSPACES_ROOT } from "./paths.js";
import { violations } from "./policy.js";

// Runs the OpenCode harness (`opencode serve`) with our config, plus a tiny admin port that
// creates the spaces' folders (they live on this pod's volume, which the api doesn't mount).
// It's a separate process from the backend, so backend restarts during development don't kill
// it (and don't leave an orphan holding the port).

// `opencode serve` inherits this environment: with OPENCODE_SERVER_PASSWORD set it requires
// that password (HTTP Basic auth) on every request; the username must match the api's.
process.env.OPENCODE_SERVER_USERNAME ??= HARNESS_USER;
// Only OUR config counts. By default OpenCode also loads opencode.json, .opencode/ (agents,
// plugins, MCP servers) and AGENTS.md from the project folder — the workspace, which the agent
// can write to. One approved edit there would change the rules (or run code) for every user.
process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
// OpenCode's own config folder: our custom tools (the docs_* tools). The image sets a root-owned
// copy (/opt/ai-agent/config). With npm run dev: a fresh copy of the repo's harness-config/ OUTSIDE
// the repo (OpenCode npm-installs a package into a config folder it can write to) — and not your
// personal ~/.config/opencode, whose MCP servers and settings would otherwise join in.
if (!process.env.XDG_CONFIG_HOME) {
  const devConfig = path.join(os.homedir(), ".ai-agent", "config");
  await rm(path.join(devConfig, "opencode", "tools"), { recursive: true, force: true });
  await cp(path.resolve("harness-config"), devConfig, { recursive: true });
  process.env.XDG_CONFIG_HOME = devConfig;
}

await mkdir(CONTROL_DIR, { recursive: true }); // also creates the folder for all the spaces

const server = await createOpencodeServer({
  hostname: OPENCODE_HOSTNAME,
  port: OPENCODE_PORT,
  config,
  timeout: 60_000, // first start in a fresh container is slower
});
console.log(`OpenCode harness running at ${server.url} (spaces in ${WORKSPACES_ROOT})`);

// From here on, any failure must take `opencode serve` down with us (it's a child process that
// would otherwise keep the port).
function stop(reason: string): never {
  console.error(reason);
  server.close();
  process.exit(1);
}
process.on("uncaughtException", (err) => stop(`harness: ${err.message}`));
process.on("unhandledRejection", (err) => stop(`harness: ${(err as Error)?.message ?? err}`));

// ── Admin port: PUT /spaces/<id>?seed=starter|legacy ─────────────────────────────
// Creates a space's folder (private to this user: 0700) and fills a NEW one with the starter
// files — or, for the single owner from before spaces, the old shared folder's files. An
// existing folder is never touched. Same password as OpenCode; inside the cluster only.

const SEEDS = { starter: WORKSPACE_SEED, legacy: LEGACY_WORKSPACE };
const digest = (value: string) => createHash("sha256").update(value).digest();
const authorized = (header: string | undefined) =>
  !HARNESS_AUTHORIZATION || timingSafeEqual(digest(header ?? ""), digest(HARNESS_AUTHORIZATION));
const exists = (file: string) => access(file).then(() => true, () => false);

// Copy plain files and folders only: no links (they'd point outside the space), no .git (its
// config can make git run commands), no .opencode.
async function copyable(source: string) {
  const name = path.basename(source);
  return name !== ".git" && name !== ".opencode" && !(await lstat(source)).isSymbolicLink();
}

// A new folder is filled in a hidden temporary folder and only then renamed into place: a copy
// that fails halfway (disk full, pod stopped) never leaves a half-filled space behind.
async function createSpace(id: string, seed: string): Promise<boolean> {
  const dir = spaceDir(id);
  if (await exists(dir)) return false;
  const temp = path.join(WORKSPACES_ROOT, `.new-${id}-${randomUUID()}`);
  try {
    await mkdir(temp, { mode: 0o700 });
    if (await exists(seed)) await cp(seed, temp, { recursive: true, force: false, errorOnExist: false, filter: copyable });
    await rename(temp, dir);
    return true;
  } catch (err) {
    if (await exists(dir)) return false; // another request created it at the same moment
    throw err;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

// Leftovers of copies that were cut off (the harness stopped in the middle).
for (const name of await readdir(WORKSPACES_ROOT)) {
  if (name.startsWith(".new-")) await rm(path.join(WORKSPACES_ROOT, name), { recursive: true, force: true });
}

const admin = createServer(async (req, res) => {
  const send = (status: number, body: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!authorized(req.headers.authorization)) return send(401, { error: "Unauthorized" });
  const url = new URL(req.url ?? "/", "http://harness");
  const id = /^\/spaces\/([^/]+)$/.exec(url.pathname)?.[1] ?? "";
  if (req.method !== "PUT" || !UUID.test(id)) return send(404, { error: "Not found" });
  try {
    const created = await createSpace(id, SEEDS[url.searchParams.get("seed") === "legacy" ? "legacy" : "starter"]);
    if (created) console.log(`[spaces] created ${spaceDir(id)}`);
    send(created ? 201 : 200, { created });
  } catch (err) {
    console.error(`[spaces] couldn't prepare ${id}:`, (err as Error).message);
    send(500, { error: "Couldn't prepare the folder" });
  }
});
admin.on("error", (err) => stop(`admin port ${HARNESS_ADMIN_PORT}: ${err.message}`));
admin.listen(HARNESS_ADMIN_PORT, OPENCODE_HOSTNAME, () => console.log(`admin port on ${OPENCODE_HOSTNAME}:${HARNESS_ADMIN_PORT}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    admin.close();
    server.close();
    process.exit(0);
  });
}

// ── Policy check ──────────────────────────────────────────────────────────────────
// Read back what OpenCode will ACTUALLY enforce and refuse to run if it's wrong. (A config quirk
// once turned "edit: available" into "edit: allow" — file changes without approval; OpenCode
// also adds rules of its own. Never again silently: the harness exits, and Kubernetes shows it.)
// Every folder gets the same rules (project config is off), so the control folder stands in.
// Anything that can't be read counts as wrong.

const [agents, tools, effective] = await Promise.all([client.app.agents({}), client.tool.ids({}), client.config.get({})]);
const agent = agents.data?.find((a) => a.name === AGENT);
const problems = agent ? violations(agent.permission) : [`agent "${AGENT}" not found (could not read the agents)`];
// The document tools must be loaded (custom tools from the config folder)…
const DOCS = ["docs_search_documents", "docs_list_documents", "docs_read_document"];
if (!tools.data) problems.push("could not read the tool list");
const missing = DOCS.filter((id) => !tools.data?.includes(id));
if (tools.data && missing.length) problems.push(`document tools not loaded: ${missing.join(", ")} (is XDG_CONFIG_HOME right?)`);
// …and no MCP server at all: one from anywhere else could run code, or shadow the docs tools.
if (!effective.data) problems.push("could not read the effective config");
const servers = Object.keys(effective.data?.mcp ?? {});
if (servers.length) problems.push(`unexpected MCP servers: ${servers.join(", ")}`);
if (problems.length) {
  admin.close();
  stop(`POLICY CHECK FAILED for agent "${AGENT}":\n  ${problems.join("\n  ")}`);
}
console.log(`policy check passed: edits need approval (never in .git), no shell, no web, no sub-agents, nothing outside the conversation's folder (incl. tool output); tools: ${DOCS.join(", ")}`);
