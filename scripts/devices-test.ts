// Security test for "Connect a device" (server/devices.ts): two TEMPORARY users connect,
// use and revoke a device, then are deleted. Checks the gateway key, the MCP token, isolation
// and revocation end to end through nginx.
//
//   npm run devices:test        (app at http://localhost:8080; needs .env for the Keycloak admin)

import { randomBytes } from "node:crypto";
import { keycloakAdmin } from "./lib/keycloak-admin.js";
import { Session } from "./lib/session.js";

try {
  process.loadEnvFile();
} catch {}
const APP = process.env.SEYL_PUBLIC_URL ?? "http://localhost:8080";
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

const { url: KC, close } = await keycloakAdmin();
const token = ((await (await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "" }) })).json()) as { access_token: string }).access_token;
const kc = (path: string, init: RequestInit = {}) => fetch(`${KC}/admin/realms/seyl${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
const created: string[] = [];
async function user() {
  const username = `dev-${randomBytes(3).toString("hex")}`, password = randomBytes(12).toString("base64url") + "-Aa1!";
  await kc("/users", { method: "POST", body: JSON.stringify({ username, email: `${username}@seyl.test`, emailVerified: true, firstName: "Dev", enabled: true }) });
  const [{ id }] = (await (await kc(`/users?username=${username}&exact=true`)).json()) as { id: string }[];
  await kc(`/users/${id}/reset-password`, { method: "PUT", body: JSON.stringify({ type: "password", value: password, temporary: false }) });
  created.push(id);
  const s = new Session(APP);
  await s.signIn(username, password);
  return s;
}

const llm = (key: string, path: string, body?: unknown) =>
  fetch(`${APP}/llm/v1${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const mcp = (auth: string | undefined, extra: Record<string, string> = {}) =>
  fetch(`${APP}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: auth } : {}), ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

try {
  const alice = await user();
  const bob = await user();

  // Connect a device
  const res = await alice.api("/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Test laptop" }) });
  const dev = (await res.json()) as { device: { id: string }; apiKey: string; mcpToken: string; gatewayUrl: string; mcpUrl: string };
  check(res.status === 201 && dev.apiKey.startsWith("sk-") && dev.mcpToken.startsWith("seyl_mcp_"), "connect a device → 201 with a gateway key and an MCP token");
  check(dev.gatewayUrl === `${APP}/llm/v1` && dev.mcpUrl === `${APP}/mcp`, "returns the public gateway and MCP URLs");
  const list = await (await alice.api("/devices")).text();
  check(!list.includes(dev.apiKey) && !list.includes(dev.mcpToken) && list.includes("Test laptop"), "device list shows the device but never its secrets");

  // The gateway key
  const models = (await (await llm(dev.apiKey, "/models")).json()) as { data: { id: string }[] };
  const ids = models.data.map((m) => m.id).sort().join(",");
  check(ids === "qwen3.5-0.8b,qwen3.5-9b", `device key sees only the chat models (${ids})`);
  const chat = await llm(dev.apiKey, "/chat/completions", { model: "qwen3.5-9b", reasoning_effort: "none", max_tokens: 10, messages: [{ role: "user", content: "Say OK." }] });
  check(chat.status === 200, `device key can chat (HTTP ${chat.status})`);
  const guard = await llm(dev.apiKey, "/chat/completions", { model: "qwen3-guard", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  check(guard.status === 401 || guard.status === 403, `device key cannot use other models, e.g. the guard (HTTP ${guard.status})`);

  // The MCP token
  const ok = await mcp(`Bearer ${dev.mcpToken}`);
  const tools = await ok.text();
  check(ok.status === 200 && tools.includes("search_documents"), "device MCP token lists the document tools at /mcp");
  check((await mcp(`Bearer ${process.env.SEYL_MCP_TOKEN}`)).status === 401, "the harness's internal token is refused at /mcp");
  check((await mcp(undefined)).status === 401, "no token → 401");
  check((await mcp(`Bearer seyl_mcp_${"A".repeat(43)}`)).status === 401, "a made-up device token → 401");
  check((await mcp(`Bearer ${dev.mcpToken}`, { Origin: "https://evil.example" })).status === 403, "a browser request (Origin header) → 403");

  // Isolation
  const bobsView = (await (await bob.api("/devices")).json()) as unknown[];
  check(bobsView.length === 0, "another user doesn't see the device");
  check((await bob.api(`/devices/${dev.device.id}`, { method: "DELETE" })).status === 404, "another user can't disconnect it (404)");
  const noCsrf = await fetch(`${APP}/api/devices`, { method: "POST", headers: { Cookie: `seyl_session=${alice.cookies.get("seyl_session")}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) });
  check(noCsrf.status === 403, "connecting without the anti-CSRF header → 403");

  // Revoke
  check((await alice.api(`/devices/${dev.device.id}`, { method: "DELETE" })).status === 204, "the owner disconnects it (204)");
  const after = await llm(dev.apiKey, "/models");
  check(after.status === 401, `its gateway key stops working (HTTP ${after.status})`);
  check((await mcp(`Bearer ${dev.mcpToken}`)).status === 401, "its MCP token stops working");
} finally {
  for (const id of created) await kc(`/users/${id}`, { method: "DELETE" }).catch(() => {});
  console.log(`(${created.length} temporary users deleted)`);
  close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
