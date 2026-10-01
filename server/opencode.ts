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

// The harness has full control of the agent (its config, sessions, a shell endpoint), so it
// requires a password — OpenCode's own HTTP Basic auth — and only the api knows it. Anything
// else that can reach it (another pod, a process on the PC) gets 401. Set in the containers;
// optional with npm run dev, where the harness listens on 127.0.0.1 only.
export const HARNESS_USER = env.OPENCODE_SERVER_USERNAME ?? "seyl-api";
const HARNESS_PASSWORD = env.OPENCODE_SERVER_PASSWORD;
if (env.NODE_ENV === "production" && (HARNESS_PASSWORD ?? "").length < 32) {
  throw new Error("OPENCODE_SERVER_PASSWORD (32+ characters) is required in production (see .env.example)");
}

// The LiteLLM gateway (gateway/config.yaml) — the only way the harness reaches a model.
// It uses its own key, which may call only the chat models (scripts/gateway-keys.ts).
export const LLM_GATEWAY_URL = env.LLM_GATEWAY_URL ?? "http://127.0.0.1:4000";
const HARNESS_KEY = env.LITELLM_KEY_HARNESS;

// seyl-ai's MCP tool server (server/mcp.ts, in the api, own port) — the agent's document tools.
const MCP_URL = env.SEYL_MCP_URL ?? "http://127.0.0.1:3001/mcp";
const MCP_TOKEN = env.SEYL_MCP_TOKEN ?? "";

// The folder the agent is allowed to work in. OpenCode treats it as its "project".
// This path is sent to the harness, so it must exist where the *harness* runs.
export const WORKSPACE = env.SEYL_WORKSPACE ?? path.resolve("workspace");

// Model names as the gateway knows them — not where they run. The gateway maps
// them to Ollama today; on AWS it could map the same names to Amazon Bedrock.
const MAIN_MODEL = "qwen3.5-9b"; // chat, agent loop, tools, images
const SMALL_MODEL = "qwen3.5-0.8b"; // quick jobs such as chat titles

export const MODEL = { providerID: "gateway", modelID: MAIN_MODEL };
export const FAST_VARIANT = "fast"; // the main model without thinking (see variants below)

// seyl-ai's own agent: its system prompt (server/prompts/seyl-ai.md) replaces OpenCode's
// built-in coding prompt, and it may only use the read-only tools below.
export const AGENT = "seyl";
const SYSTEM_PROMPT = readFileSync(new URL("./prompts/seyl-ai.md", import.meta.url), "utf8");
export const MODEL_INFO: ModelInfo = { provider: "LiteLLM", name: "Qwen3.5 9B", vision: true };

// OpenCode configuration, passed straight to the `opencode serve` process.
// Same shape as an opencode.json file.
export const config: Config = {
  share: "disabled",
  // Every tool result goes into the model's context. OpenCode's default cap (2,000 lines /
  // 50 KB ≈ 12k tokens) suits 200k-token cloud models; ours has 32k. Longer output is saved
  // to a file and the model is told to read the rest in pieces (read with offset, grep).
  tool_output: { max_lines: 400, max_bytes: 16 * 1024 },
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
          // Qwen3.5 thinks before it answers (the "Thoughts" in the UI). Better on hard
          // questions, but every thought token costs time. "fast" answers straight away.
          variants: { fast: { reasoningEffort: "none" } },
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
      // What this agent may do: "allow" (on its own), "ask" (pauses; the UI shows Allow / Deny)
      // or "deny" (the tool isn't even offered — fewer tool definitions = fewer tokens).
      //
      // Written as permissions on purpose. The older `tools: { edit: true }` form looks like
      // "make edit available" but OpenCode turns it into `edit: "allow"` — silently overriding
      // the global "ask". server/harness.ts verifies the effective rules at startup.
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: "ask", // create or change a file (edit, write) — only with the user's approval
        "docs_*": "allow", // document tools from our MCP server (search, list, read)
        bash: "deny",
        apply_patch: "deny",
        webfetch: "deny",
        websearch: "deny",
        task: "deny", // sub-agents
        todowrite: "deny",
        skill: "deny",
        question: "deny", // would pause for an answer the UI can't give yet
        external_directory: "deny",
      },
      steps: 12, // at most 12 model calls per message: stops runaway agent loops
    },
  },
  // MCP servers: tools that live outside OpenCode. "docs" = seyl-ai's document library.
  mcp: {
    docs: {
      type: "remote",
      url: MCP_URL,
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      oauth: false,
      timeout: 30_000,
    },
  },
  // What the agent may do on its own ("allow"), only with approval ("ask" — it pauses and
  // the UI shows Allow / Deny), or never ("deny"). File changes need approval; shell
  // commands, web access and anything outside the workspace are off.
  permission: {
    edit: "ask",
    bash: "deny",
    webfetch: "deny",
    external_directory: "deny",
  },
};

// Typed client for the OpenCode HTTP API, scoped to our workspace folder.
export const client = createOpencodeClient({
  baseUrl: OPENCODE_URL,
  directory: WORKSPACE,
  ...(HARNESS_PASSWORD && {
    headers: { Authorization: `Basic ${Buffer.from(`${HARNESS_USER}:${HARNESS_PASSWORD}`).toString("base64")}` },
  }),
});
