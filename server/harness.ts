import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { AGENT, client, config, OPENCODE_HOSTNAME, OPENCODE_PORT, WORKSPACE } from "./opencode.js";

// Runs the OpenCode harness (`opencode serve`) with our config.
// It's a separate process from the backend, so backend restarts during
// development don't kill it (and don't leave an orphan holding the port).
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
const wrong = Object.entries(REQUIRED).filter(([action, expected]) => rules[action] !== expected);
if (!effective.data || wrong.length) {
  const detail = wrong.map(([action, expected]) => `${action} is ${JSON.stringify(rules[action])}, must be "${expected}"`);
  console.error(`POLICY CHECK FAILED for agent "${AGENT}": ${detail.join("; ") || "could not read the config"}`);
  server.close();
  process.exit(1);
}
console.log(`policy check passed: ${Object.entries(REQUIRED).map(([a, e]) => `${a}=${e}`).join(", ")}`);
