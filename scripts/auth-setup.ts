// Configures Keycloak for seyl-ai through its admin API (safe to run again).
//
//   npm run auth:setup                                  # Keycloak via http://localhost:8080/auth (nginx)
//   KEYCLOAK_URL=http://127.0.0.1:8081/auth npm run auth:setup   # e.g. through a port-forward
//
// Creates / updates:
//   - realm "seyl"            — seyl-ai's own space for users (separate from Keycloak's "master")
//   - client "seyl-web"       — the api, as a CONFIDENTIAL client (it has a secret: OIDC_CLIENT_SECRET)
//                               using the Authorization Code flow with PKCE (S256) only
//   - user "faisal"           — a local test account (password: SEYL_USER_PASSWORD in .env)

export {};

try {
  process.loadEnvFile();
} catch {}

const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:8080/auth";
const PUBLIC_URL = process.env.SEYL_PUBLIC_URL ?? "http://localhost:8080";
const REALM = "seyl";

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
  displayName: "seyl-ai",
  enabled: true,
  registrationAllowed: false, // accounts are created by an admin, not by strangers
  loginWithEmailAllowed: true,
  bruteForceProtected: true, // lock out password guessing
  accessTokenLifespan: 300,
  ssoSessionIdleTimeout: 8 * 3600,
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
  clientId: "seyl-web",
  name: "seyl-ai",
  enabled: true,
  protocol: "openid-connect",
  publicClient: false, // confidential: the api keeps a secret; browsers never see tokens
  secret: required("OIDC_CLIENT_SECRET"),
  standardFlowEnabled: true, // Authorization Code flow…
  implicitFlowEnabled: false, // …and not the old, insecure implicit flow (OAuth 2.1 removes it)
  directAccessGrantsEnabled: false, // no password grant for the app (OAuth 2.1 removes it too)
  serviceAccountsEnabled: false,
  redirectUris: [`${PUBLIC_URL}/api/auth/callback`],
  webOrigins: [PUBLIC_URL],
  attributes: {
    "pkce.code.challenge.method": "S256", // PKCE required
    "post.logout.redirect.uris": `${PUBLIC_URL}/*`,
  },
};
const [existingClient] = ((await admin("GET", `/${REALM}/clients?clientId=seyl-web`)) ?? []) as { id: string }[];
if (existingClient) await admin("PUT", `/${REALM}/clients/${existingClient.id}`, { ...client, id: existingClient.id });
else await admin("POST", `/${REALM}/clients`, client);
console.log(`✓ client seyl-web ${existingClient ? "updated" : "created"} (confidential, code flow + PKCE S256)`);

// ── Test user ──
const user = {
  username: "faisal",
  email: "faisal@seyl.test", // .test is reserved for testing — never a real mailbox
  emailVerified: true,
  firstName: "Faisal",
  lastName: "",
  enabled: true,
};
const [existingUser] = ((await admin("GET", `/${REALM}/users?username=faisal&exact=true`)) ?? []) as { id: string }[];
if (existingUser) await admin("PUT", `/${REALM}/users/${existingUser.id}`, user);
else await admin("POST", `/${REALM}/users`, user);
const [{ id: userId }] = (await admin("GET", `/${REALM}/users?username=faisal&exact=true`)) as { id: string }[];
await admin("PUT", `/${REALM}/users/${userId}/reset-password`, { type: "password", value: required("SEYL_USER_PASSWORD"), temporary: false });
console.log(`✓ user faisal ${existingUser ? "updated" : "created"} (password from .env: SEYL_USER_PASSWORD)`);
