import "./env.js";
import { readFileSync } from "node:fs";
import { createOpencodeClient, type Config } from "@opencode-ai/sdk/v2";
import type { ModelInfo } from "../shared/chat.js";
import { CONTROL_DIR, TOOL_OUTPUT_GLOB } from "./paths.js";

// Settings come from environment variables so the same code runs locally
// (defaults below), in Docker Compose and in Kubernetes (see k8s/).
// Locally, secrets come from .env (server/env.ts); containers get them from Compose / a Kubernetes Secret.
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
export const HARNESS_USER = env.OPENCODE_SERVER_USERNAME ?? "ai-agent-api";
const HARNESS_PASSWORD = env.OPENCODE_SERVER_PASSWORD;
if (env.NODE_ENV === "production" && (HARNESS_PASSWORD ?? "").length < 32) {
  throw new Error("OPENCODE_SERVER_PASSWORD (32+ characters) is required in production (see .env.example)");
}
export const HARNESS_AUTHORIZATION = HARNESS_PASSWORD
  ? `Basic ${Buffer.from(`${HARNESS_USER}:${HARNESS_PASSWORD}`).toString("base64")}`
  : undefined;

// The harness's own small admin port (server/harness.ts): creates the spaces' folders, which live
// on the harness's volume. Same password.
export const HARNESS_ADMIN_PORT = Number(env.AI_AGENT_HARNESS_ADMIN_PORT ?? OPENCODE_PORT + 1);
export const HARNESS_ADMIN_URL = env.AI_AGENT_HARNESS_ADMIN_URL ?? `http://127.0.0.1:${HARNESS_ADMIN_PORT}`;

// The LiteLLM gateway (gateway/config.yaml) — the only way the harness reaches a model.
// It uses its own key, which may call only the chat models (scripts/gateway-keys.ts).
export const LLM_GATEWAY_URL = env.LLM_GATEWAY_URL ?? "http://127.0.0.1:4000";
const HARNESS_KEY = env.LITELLM_KEY_HARNESS;


// Model names as the gateway knows them — not where they run. The gateway maps
// them to Ollama today; on AWS it could map the same names to Amazon Bedrock.
const MAIN_MODEL = "qwen3.5-9b"; // chat, agent loop, tools, images
const SMALL_MODEL = "qwen3.5-0.8b"; // quick jobs such as chat titles

export const MODEL = { providerID: "gateway", modelID: MAIN_MODEL };
export const FAST_VARIANT = "fast"; // the main model without thinking (see variants below)

// Ai-Agent's own agent: its system prompt (server/prompts/ai-agent.md) replaces OpenCode's
// built-in coding prompt, and it may only use the read-only tools below.
export const AGENT = "ai-agent";
const SYSTEM_PROMPT = readFileSync(new URL("./prompts/ai-agent.md", import.meta.url), "utf8");
export const MODEL_INFO: ModelInfo = { provider: "LiteLLM", name: "Qwen3.5 9B", vision: true };

// File changes need the user's approval — except inside a .git folder (or a .git file), never:
// with many users, the user IS the one approving, and a .git config can make the git commands
// OpenCode runs on a folder execute anything. Patterns are paths relative to the file system root
// ("data/workspaces/<id>/.git/config"); "*" also matches across folders.
export const EDIT = { "*": "ask", "*/.git": "deny", "*/.git/*": "deny" } as const;

// Nothing outside the conversation's folder — including OpenCode's shared tool-output folder,
// which it would otherwise allow for every agent (server/paths.ts).
export const OUTSIDE = { "*": "deny", [TOOL_OUTPUT_GLOB]: "deny" } as const;

// OpenCode configuration, passed straight to the `opencode serve` process.
// Same shape as an opencode.json file.
export const config: Config = {
  share: "disabled",
  // Every tool result goes into the model's context. OpenCode's default cap (2,000 lines /
  // 50 KB ≈ 12k tokens) suits 200k-token cloud models; ours has 32k. OpenCode saves longer output
  // to its shared tool-output folder, which our agent may NOT open (other users' output is there):
  // the system prompt tells the model to narrow its search instead.
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
      description: "Ai-Agent: a local assistant that finds, searches and reads workspace files",
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
        edit: EDIT, // create or change a file (edit, write) — only with the user's approval
        "docs_*": "allow", // the document tools (harness-config/opencode/tools/docs.js)
        bash: "deny",
        apply_patch: "deny",
        webfetch: "deny",
        websearch: "deny",
        task: "deny", // sub-agents
        todowrite: "deny",
        skill: "deny",
        question: "deny", // would pause for an answer the UI can't give yet
        external_directory: OUTSIDE,
      },
      steps: 12, // at most 12 model calls per message: stops runaway agent loops
    },
  },
  // No MCP servers: the document tools are custom tools now (harness-config/opencode/tools/docs.js),
  // because a custom tool learns WHICH conversation is calling (an MCP server can't tell users apart).
  mcp: {},
  // What the agent may do on its own ("allow"), only with approval ("ask" — it pauses and
  // the UI shows Allow / Deny), or never ("deny"). File changes need approval; shell
  // commands, web access and anything outside the workspace are off.
  permission: {
    edit: EDIT,
    bash: "deny",
    webfetch: "deny",
    external_directory: OUTSIDE,
  },
};

// Typed client for the OpenCode HTTP API. OpenCode runs one "instance" per folder, so every call
// about a conversation passes that conversation's folder (`directory`); calls about a session id
// always run in the session's own folder anyway. The default is an empty control folder.
export const client = createOpencodeClient({
  baseUrl: OPENCODE_URL,
  directory: CONTROL_DIR,
  ...(HARNESS_AUTHORIZATION && { headers: { Authorization: HARNESS_AUTHORIZATION } }),
});
