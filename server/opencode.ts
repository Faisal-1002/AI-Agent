import { readFileSync } from "node:fs";
import path from "node:path";
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2";
import type { ModelInfo } from "../shared/chat.js";

// Settings come from environment variables so the same code runs locally
// (defaults below), in Docker Compose and in Kubernetes (see k8s/).
// Locally, secrets come from .env; containers get them from Compose / a Kubernetes Secret.
try {
  process.loadEnvFile();
} catch {}
const env = process.env;

// Where the OpenCode harness listens (started by server/harness.ts).
// 127.0.0.1 locally; 0.0.0.0 in a container so other containers can reach it.
export const OPENCODE_HOSTNAME = env.OPENCODE_HOSTNAME ?? "127.0.0.1";
export const OPENCODE_PORT = Number(env.OPENCODE_PORT ?? 4097);

// How the backend reaches the harness (e.g. http://harness:4097 in a cluster).
export const OPENCODE_URL = env.OPENCODE_URL ?? `http://127.0.0.1:${OPENCODE_PORT}`;

// The LiteLLM gateway (gateway/config.yaml) — the only way the harness reaches a model.
// It uses its own key, which may call only the chat models (scripts/gateway-keys.ts).
export const LLM_GATEWAY_URL = env.LLM_GATEWAY_URL ?? "http://127.0.0.1:4000";
const HARNESS_KEY = env.LITELLM_KEY_HARNESS;

// seyl-ai's MCP tool server (server/mcp.ts, in the api) — the agent's document tools.
const SEYL_API_URL = env.SEYL_API_URL ?? "http://127.0.0.1:3000";
const MCP_TOKEN = env.SEYL_MCP_TOKEN ?? "";

// The folder the agent is allowed to work in. OpenCode treats it as its "project".
// This path is sent to the harness, so it must exist where the *harness* runs.
export const WORKSPACE = env.SEYL_WORKSPACE ?? path.resolve("workspace");

// Model names as the gateway knows them — not where they run. The gateway maps
// them to Ollama today; on AWS it could map the same names to Amazon Bedrock.
const MAIN_MODEL = "qwen3.5-9b"; // chat, agent loop, tools, images
const SMALL_MODEL = "qwen3.5-0.8b"; // quick jobs such as chat titles

export const MODEL = { providerID: "gateway", modelID: MAIN_MODEL };

// seyl-ai's own agent: its system prompt (server/prompts/seyl-ai.md) replaces OpenCode's
// built-in coding prompt, and it may only use the read-only tools below.
export const AGENT = "seyl";
const SYSTEM_PROMPT = readFileSync(new URL("./prompts/seyl-ai.md", import.meta.url), "utf8");
export const MODEL_INFO: ModelInfo = { provider: "LiteLLM", name: "Qwen3.5 9B", vision: true };

// OpenCode configuration, passed straight to the `opencode serve` process.
// Same shape as an opencode.json file.
export const config: Config = {
  share: "disabled",
  autoupdate: false,
  model: `gateway/${MAIN_MODEL}`,
  // Titles etc. go to a tiny model, so they don't queue behind the main one.
  small_model: `gateway/${SMALL_MODEL}`,
  provider: {
    gateway: {
      npm: "@ai-sdk/openai-compatible",
      name: "LiteLLM gateway",
      options: { baseURL: `${LLM_GATEWAY_URL}/v1`, apiKey: HARNESS_KEY },
      models: {
        [MAIN_MODEL]: {
          name: "Qwen3.5 9B",
          reasoning: true,
          tool_call: true,
          attachment: true, // can receive images
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 32768, output: 8192 },
        },
        [SMALL_MODEL]: {
          name: "Qwen3.5 0.8B",
          reasoning: false,
          tool_call: false,
          limit: { context: 8192, output: 512 },
          // Qwen3.5 thinks by default; for a title that just burns the token budget.
          // Sent as reasoning_effort: "none" (the gateway passes it on to Ollama).
          options: { reasoningEffort: "none" },
        },
      },
    },
  },
  agent: {
    [AGENT]: {
      mode: "primary",
      description: "seyl-ai: a local assistant that finds, searches and reads workspace files",
      prompt: SYSTEM_PROMPT,
      // Allow-list: only these tools are offered to the model. Every tool definition is sent
      // with every request, so fewer tools also means fewer tokens (and a faster first answer).
      tools: {
        read: true,
        glob: true,
        grep: true,
        "docs_*": true, // document tools from our MCP server (search, list, read)
        bash: false,
        edit: false,
        write: false,
        apply_patch: false,
        webfetch: false,
        websearch: false,
        task: false, // sub-agents
        todowrite: false,
        skill: false,
        question: false, // would pause for an answer the UI can't give yet
      },
      steps: 12, // at most 12 model calls per message: stops runaway agent loops
    },
  },
  // MCP servers: tools that live outside OpenCode. "docs" = seyl-ai's document library.
  mcp: {
    docs: {
      type: "remote",
      url: `${SEYL_API_URL}/mcp`,
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      oauth: false,
      timeout: 30_000,
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
