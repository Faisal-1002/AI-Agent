// Configures Keycloak for Ai-Agent through its admin API (safe to run again).
//
//   npm run auth:setup      # reaches Keycloak's admin API directly (scripts/lib/keycloak-admin.ts)
//
// Creates / updates:
//   - realm "ai-agent"        — Ai-Agent's own space for users (separate from Keycloak's "master")
//   - client "ai-agent-web"   — the api, as a CONFIDENTIAL client (it has a secret: OIDC_CLIENT_SECRET)
//                               using the Authorization Code flow with PKCE (S256) only
//   - a security baseline     — a client policy for EVERY client in the realm: PKCE (S256),
//                               no implicit flow, no password grant (OAuth 2.0 best practice, RFC 9700)
//   - user "faisal"           — a local test account (password: AI_AGENT_USER_PASSWORD in .env)
//   - master realm            — brute-force protection for the admin account

import { keycloakAdmin } from "./lib/keycloak-admin.js";

try {
  process.loadEnvFile();
} catch {}

const { url: KEYCLOAK, close } = await keycloakAdmin();
const PUBLIC_URL = process.env.AI_AGENT_PUBLIC_URL ?? "http://localhost:8080";
const REALM = "ai-agent";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

// An admin token from the master realm (password grant is fine for a local admin script).
const tokenRes = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: required("KEYCLOAK_ADMIN_PASSWORD") }),
});
if (!tokenRes.ok) throw new Error(`Admin login failed: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
const { access_token } = (await tokenRes.json()) as { access_token: string };

async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(`${KEYCLOAK}/admin/realms${path}`, {
    method,
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 404 ? undefined : res.headers.get("content-type")?.includes("json") ? res.json() : undefined;
}

// ── Realm ──
const realm = {
  realm: REALM,
  displayName: "Ai-Agent",
  loginTheme: "ai-agent", // the app's look on the login page (keycloak/themes/ai-agent)
  enabled: true,
  registrationAllowed: false, // accounts are created by an admin, not by strangers
  loginWithEmailAllowed: true,
  bruteForceProtected: true, // lock out password guessing
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 8 * 3600,
  // Refresh tokens are single-use (best practice for public clients such as the account
  // console). ai-agent-web doesn't keep refresh tokens at all.
  revokeRefreshToken: true,
  refreshTokenMaxReuse: 0,
};
const existingRealm = await admin("GET", `/${REALM}`);
await admin(existingRealm ? "PUT" : "POST", existingRealm ? `/${REALM}` : "", realm);
console.log(`✓ realm ${REALM} ${existingRealm ? "updated" : "created"}`);

// ── User profile: first/last name optional ──
// Keycloak's declarative user profile requires a last name by default, which sends users
// to an extra "verify profile" form on their first login.
const profile = (await admin("GET", `/${REALM}/users/profile`)) as { attributes: { name: string; required?: unknown }[] };
for (const attribute of profile.attributes) if (attribute.name === "firstName" || attribute.name === "lastName") delete attribute.required;
await admin("PUT", `/${REALM}/users/profile`, profile);
console.log("✓ user profile: first and last name optional");

// ── Client (the api, as a BFF) ──
const client = {
  clientId: "ai-agent-web",
  name: "Ai-Agent",
  enabled: true,
  protocol: "openid-connect",
  publicClient: false, // confidential: the api keeps a secret; browsers never see tokens
  secret: required("OIDC_CLIENT_SECRET"),
  standardFlowEnabled: true, // Authorization Code flow…
  implicitFlowEnabled: false, // …and not the old, insecure implicit flow (RFC 9700: don't use it)
  directAccessGrantsEnabled: false, // no password grant for the app (RFC 9700: must not be used)
  serviceAccountsEnabled: false,
  redirectUris: [`${PUBLIC_URL}/api/auth/callback`],
  webOrigins: [PUBLIC_URL],
  attributes: {
    "pkce.code.challenge.method": "S256", // PKCE required
    "post.logout.redirect.uris": `${PUBLIC_URL}/`, // exact: no wildcard (no redirect to arbitrary paths)
  },
};
const [existingClient] = ((await admin("GET", `/${REALM}/clients?clientId=ai-agent-web`)) ?? []) as { id: string }[];
if (existingClient) await admin("PUT", `/${REALM}/clients/${existingClient.id}`, { ...client, id: existingClient.id });
else await admin("POST", `/${REALM}/clients`, client);
console.log(`✓ client ai-agent-web ${existingClient ? "updated" : "created"} (confidential, code flow + PKCE S256)`);

// ── Security baseline for every client in the realm (OAuth 2.0 + RFC 9700) ──
// ai-agent-web is already configured this way; the policy makes it the rule for ALL clients —
// including the ones Keycloak creates itself (e.g. "admin-cli" allows the password grant).
// Not Keycloak's built-in "oauth-2-1-for-confidential-client" profile: that one also demands
// signed-JWT client authentication and certificate-bound tokens, which ai-agent-web doesn't do.
await admin("PUT", `/${REALM}/client-policies/profiles`, {
  profiles: [
    {
      name: "ai-agent-security-baseline",
      description: "PKCE with S256, no implicit flow, no password grant",
      executors: [
        { executor: "pkce-enforcer", configuration: { "auto-configure": "true" } },
        { executor: "reject-implicit-grant", configuration: { "auto-configure": "true" } },
        { executor: "reject-ropc-grant", configuration: { "auto-configure": "true" } },
      ],
    },
  ],
});
await admin("PUT", `/${REALM}/client-policies/policies`, {
  policies: [
    {
      name: "ai-agent-security-baseline",
      description: "Applies the security baseline to every client",
      enabled: true,
      conditions: [{ condition: "any-client", configuration: {} }],
      profiles: ["ai-agent-security-baseline"],
    },
  ],
});
// And switch the password grant off on the realm's own admin-cli client (nothing uses it).
const [realmAdminCli] = ((await admin("GET", `/${REALM}/clients?clientId=admin-cli`)) ?? []) as { id: string }[];
if (realmAdminCli) await admin("PUT", `/${REALM}/clients/${realmAdminCli.id}`, { id: realmAdminCli.id, clientId: "admin-cli", directAccessGrantsEnabled: false });
console.log("✓ client policy: PKCE (S256), no implicit flow, no password grant — for every client");

// ── Master realm: lock out password guessing on the admin account too ──
await admin("PUT", "/master", { realm: "master", bruteForceProtected: true });
console.log("✓ master realm: brute-force protection on");

// ── Test user ──
const user = {
  username: "faisal",
  email: "faisal@ai-agent.test", // .test is reserved for testing — never a real mailbox
  emailVerified: true,
  firstName: "Faisal",
  lastName: "",
  enabled: true,
};
const [existingUser] = ((await admin("GET", `/${REALM}/users?username=faisal&exact=true`)) ?? []) as { id: string }[];
if (existingUser) await admin("PUT", `/${REALM}/users/${existingUser.id}`, user);
else await admin("POST", `/${REALM}/users`, user);
const [{ id: userId }] = (await admin("GET", `/${REALM}/users?username=faisal&exact=true`)) as { id: string }[];
await admin("PUT", `/${REALM}/users/${userId}/reset-password`, { type: "password", value: required("AI_AGENT_USER_PASSWORD"), temporary: false });
console.log(`✓ user faisal ${existingUser ? "updated" : "created"} (password from .env: AI_AGENT_USER_PASSWORD)`);

close();
