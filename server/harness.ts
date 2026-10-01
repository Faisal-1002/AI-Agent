import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { AGENT, client, config, HARNESS_USER, OPENCODE_HOSTNAME, OPENCODE_PORT, WORKSPACE } from "./opencode.js";

// Runs the OpenCode harness (`opencode serve`) with our config.
// It's a separate process from the backend, so backend restarts during
// development don't kill it (and don't leave an orphan holding the port).
// `opencode serve` inherits this environment: with OPENCODE_SERVER_PASSWORD set it requires
// that password (HTTP Basic auth) on every request; the username must match the api's.
process.env.OPENCODE_SERVER_USERNAME ??= HARNESS_USER;
// Only OUR config counts. By default OpenCode also loads opencode.json, .opencode/ (agents,
// plugins, MCP servers) and AGENTS.md from the project folder — the workspace, which the agent
// can write to. One approved edit there would change the rules (or run code) for every user.
process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
const server = await createOpencodeServer({
  hostname: OPENCODE_HOSTNAME,
  port: OPENCODE_PORT,
  config,
  timeout: 60_000, // first start in a fresh container is slower
});
console.log(`OpenCode harness running at ${server.url} (workspace: ${WORKSPACE})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}

// Policy check: read back the EFFECTIVE permissions and refuse to run if they're wrong.
// (A config quirk once turned "edit: available" into "edit: allow" — file changes without
// approval. Never again silently: the harness exits, and Kubernetes shows it failing.)
const REQUIRED = { edit: "ask", bash: "deny", webfetch: "deny", external_directory: "deny" } as const;

const effective = await client.config.get({});
const rules = (effective.data?.agent?.[AGENT]?.permission ?? {}) as Record<string, unknown>;
const problems = Object.entries(REQUIRED)
  .filter(([action, expected]) => rules[action] !== expected)
  .map(([action, expected]) => `${action} is ${JSON.stringify(rules[action])}, must be "${expected}"`);
// Only our MCP servers: one from anywhere else (a config file in the workspace) could run code.
const servers = Object.keys(effective.data?.mcp ?? {}).sort().join(", ");
const ours = Object.keys(config.mcp ?? {}).sort().join(", ");
if (servers !== ours) problems.push(`MCP servers are [${servers}], must be [${ours}]`);
if (!effective.data || problems.length) {
  console.error(`POLICY CHECK FAILED for agent "${AGENT}": ${problems.join("; ") || "could not read the config"}`);
  server.close();
  process.exit(1);
}
console.log(`policy check passed: ${Object.entries(REQUIRED).map(([a, e]) => `${a}=${e}`).join(", ")}; MCP servers: ${ours}`);
