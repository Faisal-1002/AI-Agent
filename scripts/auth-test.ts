// Security test for login + per-user data. Creates TEMPORARY users, signs in over plain
// HTTP (the full OIDC flow, no browser), checks isolation, then deletes the users.
//
//   npm run auth:test          (app at http://localhost:8080; needs .env for the Keycloak admin)
//   Keycloak's admin API is reached directly, not through the app (scripts/lib/keycloak-admin.ts).

import { randomBytes } from "node:crypto";
import { keycloakAdmin } from "./lib/keycloak-admin.js";
import { removeUserData } from "./lib/live.js";
import { Session } from "./lib/session.js";

try {
  process.loadEnvFile();
} catch {}

const APP = process.env.SEYL_PUBLIC_URL ?? "http://localhost:8080";
const { url: KEYCLOAK, close } = await keycloakAdmin();
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
};

// ── Keycloak admin: create / delete throwaway users ──
const adminToken = (
  (await (
    await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "" }),
    })
  ).json()) as { access_token: string }
).access_token;
const kc = (path: string, init: RequestInit = {}) =>
  fetch(`${KEYCLOAK}/admin/realms/seyl${path}`, { ...init, headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" } });

const created: string[] = [];
async function createUser() {
  const username = `test-${randomBytes(3).toString("hex")}`;
  const password = randomBytes(12).toString("base64url") + "-Aa1!";
  await kc("/users", { method: "POST", body: JSON.stringify({ username, email: `${username}@seyl.test`, emailVerified: true, firstName: "Test", enabled: true }) });
  const [{ id }] = (await (await kc(`/users?username=${username}&exact=true`)).json()) as { id: string }[];
  await kc(`/users/${id}/reset-password`, { method: "PUT", body: JSON.stringify({ type: "password", value: password, temporary: false }) });
  created.push(id);
  return { username, password };
}

try {
  const alice = await createUser();
  const a = new Session(APP);

  // 1. Login starts at Keycloak, with PKCE
  const start = await a.go(`${APP}/api/auth/login`);
  check(start.status === 302 && /code_challenge_method=S256/.test(start.headers.get("location") ?? ""), "login redirects to Keycloak with PKCE (S256)");

  // 2. A wrong password is refused
  const wrong = await new Session(APP).signIn(alice.username, "wrong").then(() => "signed in", () => "refused");
  check(wrong === "refused", "wrong password is refused by Keycloak");

  // 3. The right password → session cookie
  await a.signIn(alice.username, alice.password);
  check(a.cookies.has("seyl_session"), "callback sets the session cookie");
  const me = (await (await a.api("/auth/me")).json()) as { user?: { username?: string } };
  check(me.user?.username === alice.username, `signed in as ${me.user?.username}`);

  // 4. Isolation: a new user sees none of anyone else's conversations
  const list = (await (await a.api("/conversations")).json()) as { id: string }[];
  check(Array.isArray(list) && list.length === 0, `new user sees ${list.length} conversations (expected 0)`);
  const mine = (await (await a.api("/conversations", { method: "POST" })).json()) as { id: string };
  const after = (await (await a.api("/conversations")).json()) as { id: string }[];
  check(after.length === 1 && after[0].id === mine.id, "new user can create a conversation, and sees only that one");

  // …and nobody else can open it, even knowing its id
  const bob = await createUser();
  const b = new Session(APP);
  await b.signIn(bob.username, bob.password);
  const peek = await b.api(`/conversations/${mine.id}/messages`);
  check(peek.status === 404, `another user reading it by id → ${peek.status} (expected 404)`);
  const steal = await b.api(`/conversations/${mine.id}`, { method: "DELETE" });
  check(steal.status === 404, `another user deleting it by id → ${steal.status} (expected 404)`);
  const own = await a.api(`/conversations/${mine.id}`, { method: "DELETE" });
  check(own.status === 204, "the owner can delete it");

  // 5. Logout ends the session server-side (the old cookie is dead)
  const oldCookie = a.cookies.get("seyl_session")!;
  const { logoutUrl } = (await (await a.api("/auth/logout", { method: "POST" })).json()) as { logoutUrl: string };
  check(logoutUrl.includes("/protocol/openid-connect/logout"), "logout returns the identity provider's end-session URL");
  const replay = await fetch(`${APP}/api/auth/me`, { headers: { Cookie: `seyl_session=${oldCookie}` } });
  check(replay.status === 401, "the old session cookie no longer works (replay → 401)");

  // 6. Signed out = no access
  const anonymous = await fetch(`${APP}/api/conversations`);
  check(anonymous.status === 401, "no cookie → 401");
} finally {
  // Delete every temporary user, even if one deletion fails.
  let deleted = 0;
  for (const id of created) {
    try {
      removeUserData(id); // their space, its folder, ownership rows (Keycloak id = OIDC sub)
    } catch (err) {
      console.warn(`! could not remove the data of ${id}: ${(err as Error).message}`);
    }
    const res = await kc(`/users/${id}`, { method: "DELETE" }).catch(() => undefined);
    if (res?.ok) deleted++;
    else console.warn(`! could not delete temporary user ${id} — remove it in the Keycloak admin console`);
  }
  console.log(`(${deleted}/${created.length} temporary users deleted)`);
  close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
