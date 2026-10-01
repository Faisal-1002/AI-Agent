import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { keycloakAdmin } from "./keycloak-admin.js";
import { Session } from "./session.js";

// Helpers for the live tests against the stack on Kubernetes (approvals-test, tenancy-test, …):
// kubectl/psql access, temporary users, and removing everything a temporary user leaves behind.

try {
  process.loadEnvFile();
} catch {}
export const APP = process.env.SEYL_PUBLIC_URL ?? "http://localhost:8080";

let failures = 0;
export function check(ok: boolean, what: string) {
  console.log(`${ok ? "✓" : "✗"} ${what}`);
  if (!ok) failures++;
}
export function finish(passed: string) {
  console.log(failures ? `\n${failures} check(s) failed` : `\n${passed}`);
  process.exitCode = failures ? 1 : 0;
}

export const kubectl = (...args: string[]) =>
  execFileSync("kubectl", ["-n", "seyl-ai", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const psql = (query: string) => kubectl("exec", "deploy/db", "--", "psql", "-U", "seyl", "-d", "seyl", "-v", "ON_ERROR_STOP=1", "-tAc", query);

// Ids go into shell commands and SQL: only plain ones.
export function safe(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`unexpected id: ${id}`);
  return id;
}

// Does this path exist in the harness container? (-f file, -d folder)
export function inHarness(path: string, kind: "-f" | "-d" = "-f"): boolean {
  try {
    kubectl("exec", "deploy/harness", "-c", "harness", "--", "test", kind, path);
    return true;
  } catch {
    return false;
  }
}

// Run a little script inside an api pod — it has the harness password in its environment, which
// never leaves the pod. `code` gets HARNESS_AUTH (the Basic auth header) in scope.
export function inApi(code: string): string {
  const auth = `const HARNESS_AUTH = "Basic " + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || "seyl-api") + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");`;
  return kubectl("exec", "deploy/api", "--", "node", "-e", `${auth}\n${code}`);
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false> | T | undefined | false, seconds = 240): Promise<T | undefined> {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; ) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return undefined;
}

// The folder of a user's personal space, in the harness container.
export function spaceFolder(sub: string): string {
  const id = psql(`SELECT id FROM spaces WHERE kind = 'personal' AND owner_sub = '${safe(sub)}'`);
  return `/data/workspaces/${safe(id)}`;
}

// Everything a temporary user leaves behind, except the audit log (append-only, by design).
// Database first, in one transaction: approval rules, ownership rows, login sessions, revoked
// devices, spaces (their documents and passages go too). Devices must be disconnected through the
// API first — that revokes their gateway keys; a device still active is kept, so it can be.
// Then each space folder, after closing OpenCode's instance for it; failures are reported.
export function removeUserData(sub: string) {
  const user = safe(sub);
  const ids = psql(`SELECT id FROM spaces WHERE owner_sub = '${user}'`).split("\n").filter(Boolean).map(safe);
  psql(`BEGIN;
    DELETE FROM approval_rules WHERE session_id IN (SELECT conversation_id FROM conversation_owners WHERE owner = '${user}');
    DELETE FROM conversation_owners WHERE owner = '${user}';
    DELETE FROM auth_sessions WHERE sub = '${user}';
    DELETE FROM devices WHERE owner = '${user}' AND revoked_at IS NOT NULL;
    DELETE FROM spaces WHERE owner_sub = '${user}';
    COMMIT;`);
  for (const id of ids) {
    const dir = `/data/workspaces/${id}`;
    try {
      const status = inApi(
        `fetch("http://harness:4097/instance/dispose?directory=" + encodeURIComponent(${JSON.stringify(dir)}), { method: "POST", headers: { Authorization: HARNESS_AUTH } }).then(r => console.log(r.status), e => console.log("error: " + e.message))`,
      );
      if (status !== "200") console.warn(`(couldn't close OpenCode's instance for ${dir}: ${status})`);
      kubectl("exec", "deploy/harness", "-c", "harness", "--", "rm", "-rf", dir);
    } catch (err) {
      console.warn(`! couldn't remove ${dir} — remove it by hand: ${(err as Error).message}`);
    }
  }
}

export type TempUser = { session: Session; sub: string; username: string };

// Temporary Keycloak users, signed in. cleanup() removes them and all their data.
export async function temporaryUsers() {
  const { url: KC, close } = await keycloakAdmin();
  const form = { grant_type: "password", client_id: "admin-cli", username: "admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "" };
  const { access_token } = (await (await fetch(`${KC}/realms/master/protocol/openid-connect/token`, { method: "POST", body: new URLSearchParams(form) })).json()) as { access_token: string };
  const kc = (path: string, init: RequestInit = {}) =>
    fetch(`${KC}/admin/realms/seyl${path}`, { ...init, headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" } });
  const subs: string[] = []; // Keycloak's user id is the OIDC "sub"

  async function create(prefix: string): Promise<TempUser> {
    const username = `${prefix}-${randomBytes(3).toString("hex")}`;
    const password = randomBytes(12).toString("base64url") + "-Aa1!";
    await kc("/users", { method: "POST", body: JSON.stringify({ username, email: `${username}@seyl.test`, emailVerified: true, firstName: prefix, enabled: true }) });
    const [{ id }] = (await (await kc(`/users?username=${username}&exact=true`)).json()) as { id: string }[];
    subs.push(safe(id));
    await kc(`/users/${id}/reset-password`, { method: "PUT", body: JSON.stringify({ type: "password", value: password, temporary: false }) });
    const session = new Session(APP);
    await session.signIn(username, password);
    return { session, sub: id, username };
  }

  async function cleanup() {
    for (const sub of subs) {
      try {
        removeUserData(sub);
      } catch (err) {
        console.error(`(couldn't remove the data of ${sub}: ${(err as Error).message})`);
      }
      await kc(`/users/${sub}`, { method: "DELETE" }).catch(() => {});
    }
    console.log(`(${subs.length} temporary users and their data removed)`);
    close();
  }

  return { create, cleanup };
}

// The app's API as a signed-in user: JSON in, JSON out, errors thrown with the status.
export function api(session: Session) {
  return async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await session.api(path, init);
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status} ${body?.error ?? ""}`), { status: res.status });
    return body as T;
  };
}
