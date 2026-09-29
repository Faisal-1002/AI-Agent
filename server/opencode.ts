import path from "node:path";
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2";

// Where the OpenCode harness listens (started by server/harness.ts).
export const OPENCODE_PORT = 4097;

// The folder the agent is allowed to work in. OpenCode treats it as its "project".
export const WORKSPACE = path.resolve("workspace");

// Which model OpenCode should use: provider "ollama", model created from ollama/Modelfile.
export const MODEL = { providerID: "ollama", modelID: "seyl-qwen3-8b" };

// OpenCode configuration, passed straight to the `opencode serve` process.
// Same shape as an opencode.json file.
export const config: Config = {
  share: "disabled",
  autoupdate: false,
  provider: {
    ollama: {
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama (local)",
      options: { baseURL: "http://localhost:11434/v1" },
      models: {
        "seyl-qwen3-8b": {
          name: "Qwen3 8B (16k context)",
          reasoning: true,
          tool_call: true,
          limit: { context: 16384, output: 4096 },
        },
      },
    },
  },
  // v1 is read-only: the agent may read and search files, but not change
  // anything. "ask" would pause the agent until someone approves, and the
  // UI can't approve yet — that comes with the permissions step.
  permission: {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    external_directory: "deny",
  },
};

// Typed client for the OpenCode HTTP API, scoped to our workspace folder.
export const client = createOpencodeClient({
  baseUrl: `http://127.0.0.1:${OPENCODE_PORT}`,
  directory: WORKSPACE,
});
