import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { DeviceInfo, NewDevice, User } from "../shared/chat.js";
import { audit } from "./audit.js";
import { sql } from "./db.js";
import { cleanName } from "./documents.js";
import { LLM_GATEWAY_URL } from "./opencode.js";

// "Connect a device" — for apps that can't sign in to Keycloak themselves
// (the OpenCode CLI, OpenWork desktop). A signed-in user connects a device and gets two
// secrets, shown ONCE:
//   - a gateway key (a LiteLLM virtual key): only the chat models, rate-limited, expires,
//     tied to the user — used at <public URL>/llm/v1 (deploy/nginx.conf);
//   - an MCP token for Ai-Agent's document tools at <public URL>/mcp.
// Ai-Agent stores only hashes: the gateway's own hashed key id (enough to revoke the key) and the
// SHA-256 of the MCP token. Revoking a device kills both at once.
//
// Creating keys needs the gateway's admin key (LITELLM_ADMIN_KEY), held only by the api.
// Trade-off: a compromised api could manage gateway keys. A dedicated key-issuer service with
// a narrower role is the cleaner design once there's more than one api.

const ADMIN_KEY = process.env.LITELLM_ADMIN_KEY;
const PUBLIC_URL = process.env.AI_AGENT_PUBLIC_URL ?? "http://localhost:8080";
const DEVICE_MODELS = ["qwen3.5-9b", "qwen3.5-0.8b"]; // chat + titles; never voice/guard/embeddings
const MAX_DEVICES = 10; // per user
const KEY_DAYS = 90;
const RPM_LIMIT = 30;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function gatewayAdmin(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (!ADMIN_KEY) throw new Error("Connecting devices isn't set up on this server (LITELLM_ADMIN_KEY is missing).");
  const res = await fetch(`${LLM_GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The model gateway refused ${path} (HTTP ${res.status}).`);
  return (await res.json()) as Record<string, unknown>;
}

type Row = { id: string; name: string; created_at: Date; last_used_at: Date | null; expires_at: Date };
const toInfo = (r: Row): DeviceInfo => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString(),
  expiresAt: r.expires_at.toISOString(),
});

// The /mcp entrance asks: whose device is this token? (undefined = unknown, revoked or expired)
export async function deviceOwner(token: string): Promise<string | undefined> {
  const [row] = await sql<{ owner: string }[]>`
    UPDATE devices SET last_used_at = now()
    WHERE mcp_token_hash = ${sha256(token)} AND revoked_at IS NULL AND expires_at > now()
    RETURNING owner`;
  return row?.owner;
}

export const devices = new Hono<{ Variables: { user: User } }>();

// The signed-in user's active devices (no secrets — they were shown once).
devices.get("/", async (c) => {
  const rows = await sql<Row[]>`
    SELECT id, name, created_at, last_used_at, expires_at FROM devices
    WHERE owner = ${c.get("user").sub} AND revoked_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC`;
  return c.json<DeviceInfo[]>(rows.map(toInfo));
});

// Connect a device: a new gateway key + MCP token, returned once.
devices.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
  if (typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "Give the device a name" }, 400);
  const name = cleanName(body.name).slice(0, 60);

  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM devices WHERE owner = ${user.sub} AND revoked_at IS NULL AND expires_at > now()`;
  if (count >= MAX_DEVICES) return c.json({ error: `At most ${MAX_DEVICES} connected devices — disconnect one first` }, 409);

  const id = randomUUID();
  const key = await gatewayAdmin("/key/generate", {
    models: DEVICE_MODELS,
    key_alias: `device-${id}`,
    user_id: user.sub,
    rpm_limit: RPM_LIMIT,
    duration: `${KEY_DAYS}d`,
    metadata: { ai_agent_device: id, ai_agent_owner: user.sub, kind: "device" },
  });
  const apiKey = String(key.key ?? "");
  const keyHash = String(key.token ?? "");
  if (!apiKey || !keyHash) throw new Error("The model gateway didn't return a key.");

  const mcpToken = `ai_agent_mcp_${randomBytes(32).toString("base64url")}`;
  try {
    const [row] = await sql<Row[]>`
      INSERT INTO devices (id, owner, name, gateway_key_hash, mcp_token_hash, expires_at)
      VALUES (${id}, ${user.sub}, ${name}, ${keyHash}, ${sha256(mcpToken)}, now() + ${`${KEY_DAYS} days`}::interval)
      RETURNING id, name, created_at, last_used_at, expires_at`;
    await audit(user.sub, "device.connect", id, { name });
    return c.json<NewDevice>(
      { device: toInfo(row), apiKey, mcpToken, gatewayUrl: `${PUBLIC_URL}/llm/v1`, mcpUrl: `${PUBLIC_URL}/mcp`, models: DEVICE_MODELS },
      201,
    );
  } catch (err) {
    await gatewayAdmin("/key/delete", { keys: [keyHash] }).catch(() => {}); // don't leave an orphan key
    throw err;
  }
});

// Disconnect: revoke the gateway key and the MCP token. Someone else's device → 404.
devices.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return c.json({ error: "Not found" }, 404);
  const [row] = await sql<{ gateway_key_hash: string }[]>`
    SELECT gateway_key_hash FROM devices WHERE id = ${id} AND owner = ${c.get("user").sub} AND revoked_at IS NULL`;
  if (!row) return c.json({ error: "Not found" }, 404);
  await gatewayAdmin("/key/delete", { keys: [row.gateway_key_hash] });
  await sql`UPDATE devices SET revoked_at = now() WHERE id = ${id}`;
  await audit(c.get("user").sub, "device.disconnect", id);
  return c.body(null, 204);
});
