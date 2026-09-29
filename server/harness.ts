import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { config, OPENCODE_PORT, WORKSPACE } from "./opencode.js";

// Runs the OpenCode harness (`opencode serve`) with our config.
// It's a separate process from the backend, so backend restarts during
// development don't kill it (and don't leave an orphan holding the port).
const server = await createOpencodeServer({ port: OPENCODE_PORT, config, timeout: 15_000 });
console.log(`OpenCode harness running at ${server.url} (workspace: ${WORKSPACE})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
