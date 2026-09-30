import path from "node:path";
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2";
import type { ModelInfo } from "../shared/chat.js";

// Settings come from environment variables so the same code runs locally
// (defaults below), in Docker Compose and in Kubernetes (see k8s/).
const env = process.env;

// Where the OpenCode harness listens (started by server/harness.ts).
// 127.0.0.1 locally; 0.0.0.0 in a container so other containers can reach it.
export const OPENCODE_HOSTNAME = env.OPENCODE_HOSTNAME ?? "127.0.0.1";
export const OPENCODE_PORT = Number(env.OPENCODE_PORT ?? 4097);

// How the backend reaches the harness (e.g. http://harness:4097 in a cluster).
export const OPENCODE_URL = env.OPENCODE_URL ?? `http://127.0.0.1:${OPENCODE_PORT}`;

// Where Ollama is. From a container, the host PC is host.docker.internal.
const OLLAMA_URL = env.OLLAMA_URL ?? "http://localhost:11434";

// The folder the agent is allowed to work in. OpenCode treats it as its "project".
// This path is sent to the harness, so it must exist where the *harness* runs.
export const WORKSPACE = env.SEYL_WORKSPACE ?? path.resolve("workspace");

// Which model OpenCode should use: provider "ollama", model created from ollama/Modelfile.
export const MODEL = { providerID: "ollama", modelID: "seyl-qwen3-8b" };
export const MODEL_INFO: ModelInfo = { provider: "Ollama", name: "Qwen3 8B" };

// OpenCode configuration, passed straight to the `opencode serve` process.
// Same shape as an opencode.json file.
export const config: Config = {
  share: "disabled",
  autoupdate: false,
  provider: {
    ollama: {
      npm: "@ai-sdk/openai-compatible",
      name: "Ollama (local)",
      options: { baseURL: `${OLLAMA_URL}/v1` },
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
  baseUrl: OPENCODE_URL,
  directory: WORKSPACE,
});
