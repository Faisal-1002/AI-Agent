import type { NewDevice } from "../../../shared/chat";

// The opencode.json a connected device uses: Ai-Agent as its model provider and Ai-Agent's document
// tools as an MCP server. The secrets are NOT in the file — OpenCode reads them from
// environment variables ({env:…}), so the file can be shared or committed safely.
//
// Locked down for business use. Learned the hard way: when OpenCode can't use the configured
// provider it falls back SILENTLY to its own free cloud model — a demo run sent files and
// document passages to it. So: Ai-Agent is the only provider allowed, sharing is off, and the
// agent asks before running commands, editing files or fetching web pages.
export function opencodeConfig(device: NewDevice): string {
  const config = {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["ai-agent"], // no fallback to any other provider, ever
    share: "disabled",
    permission: { edit: "ask", bash: "ask", webfetch: "ask" },
    provider: {
      "ai-agent": {
        npm: "@ai-sdk/openai-compatible",
        name: "Ai-Agent",
        options: { baseURL: device.gatewayUrl, apiKey: "{env:AI_AGENT_API_KEY}" },
        models: {
          "qwen3.5-9b": {
            name: "Qwen3.5 9B (Ai-Agent)",
            reasoning: true,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 32768, output: 8192 },
          },
          "qwen3.5-0.8b": {
            name: "Qwen3.5 0.8B (Ai-Agent)",
            limit: { context: 8192, output: 512 },
            options: { reasoningEffort: "none" },
          },
        },
      },
    },
    model: "ai-agent/qwen3.5-9b",
    small_model: "ai-agent/qwen3.5-0.8b",
    mcp: {
      "ai-agent-docs": {
        type: "remote",
        url: device.mcpUrl,
        headers: { Authorization: "Bearer {env:AI_AGENT_MCP_TOKEN}" },
        oauth: false,
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

// Commands that put the two secrets into the device's environment.
export const envCommands = (device: NewDevice) => ({
  powershell: `[Environment]::SetEnvironmentVariable("AI_AGENT_API_KEY", "${device.apiKey}", "User")\n[Environment]::SetEnvironmentVariable("AI_AGENT_MCP_TOKEN", "${device.mcpToken}", "User")`,
  bash: `export AI_AGENT_API_KEY='${device.apiKey}'\nexport AI_AGENT_MCP_TOKEN='${device.mcpToken}'`,
});
