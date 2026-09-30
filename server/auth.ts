import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { EncryptJWT, jwtDecrypt } from "jose";
import * as oidc from "openid-client";
import type { User } from "../shared/chat.js";
import { sql } from "./db.js";

// Login with OpenID Connect (Authorization Code + PKCE), as a "backend for frontend":
// the api does the whole OAuth dance server-side and gives the browser only an opaque,
// HttpOnly session cookie. Tokens never reach the browser (nothing for XSS to steal).
//
//   browser ─► /api/auth/login ─► Keycloak login page ─► /api/auth/callback?code=…
//   api ─(back channel)─► Keycloak: code + PKCE verifier + client secret ─► ID token (verified)
//   api ─► session row in Postgres ─► cookie "seyl_session" (random id; only its hash is stored)
//
// Keycloak here, but any OIDC provider works the same (on AWS: Amazon Cognito).

const env = process.env;
export const AUTH_ENABLED = env.AUTH_ENABLED === "true";
const PUBLIC_URL = env.SEYL_PUBLIC_URL ?? "http://localhost:8080";
const ISSUER = env.OIDC_ISSUER ?? `${PUBLIC_URL}/auth/realms/seyl`; // what tokens say
const INTERNAL_ISSUER = env.OIDC_INTERNAL_ISSUER; // how the api reaches it (e.g. http://keycloak:8080/…)
const CLIENT_ID = env.OIDC_CLIENT_ID ?? "seyl-web";
const REDIRECT_URI = `${PUBLIC_URL}/api/auth/callback`;
const SESSION_HOURS = 8;
const SECURE_COOKIES = PUBLIC_URL.startsWith("https://") || new URL(PUBLIC_URL).hostname === "localhost";

// Fail fast: with login on, a missing secret would mean a guessable cookie key.
if (AUTH_ENABLED && (!env.SEYL_SESSION_SECRET || !env.OIDC_CLIENT_SECRET)) {
  throw new Error("AUTH_ENABLED=true needs SEYL_SESSION_SECRET and OIDC_CLIENT_SECRET (see .env.example)");
}

// 32-byte key for the short-lived login cookie (AES-256-GCM via jose).
const flowKey = () => createHash("sha256").update(env.SEYL_SESSION_SECRET ?? "").digest();
const hash = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");

// ── Provider configuration (discovered once, retried if Keycloak isn't up yet) ──

let discovered: Promise<oidc.Configuration> | undefined;
function provider(): Promise<oidc.Configuration> {
  discovered ??= oidc
    .discovery(new URL(ISSUER), CLIENT_ID, undefined, oidc.ClientSecretPost(env.OIDC_CLIENT_SECRET), {
      // Plain HTTP is only acceptable because everything runs on localhost.
      ...(ISSUER.startsWith("http://") && { execute: [oidc.allowInsecureRequests] }),
      // Server-to-server: reach the issuer at its internal address (the back channel).
      [oidc.customFetch]: (url, options) =>
        fetch(INTERNAL_ISSUER && url.startsWith(ISSUER) ? INTERNAL_ISSUER + url.slice(ISSUER.length) : url, options as RequestInit),
    })
    .catch((err) => {
      discovered = undefined;
      throw err;
    });
  return discovered;
}

// ── Sessions ──

type SessionRow = { sub: string; name: string; email: string | null; username: string | null; id_token: string };

async function sessionUser(c: Context): Promise<(User & { idToken: string }) | undefined> {
  const id = getCookie(c, "seyl_session");
  if (!id) return undefined;
  const [row] = await sql<SessionRow[]>`
    SELECT sub, name, email, username, id_token FROM auth_sessions WHERE id_hash = ${hash(id)} AND expires_at > now()`;
  return row && { sub: row.sub, name: row.name, email: row.email ?? undefined, username: row.username ?? undefined, idToken: row.id_token };
}

const LOCAL_USER: User = { sub: "local", name: "You", local: true };

// Every /api request needs a signed-in user, except the login routes and health checks.
// With AUTH_ENABLED unset (npm run dev), everyone is the single "local" user.
const OPEN_PATHS = ["/api/auth/", "/api/healthz", "/api/readyz"];
export const requireUser = createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
  if (OPEN_PATHS.some((p) => c.req.path.startsWith(p))) return next();
  if (!AUTH_ENABLED) {
    c.set("user", LOCAL_USER);
    return next();
  }
  const user = await sessionUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  c.set("user", { sub: user.sub, name: user.name, email: user.email, username: user.username });
  return next();
});

// ── Routes ──

type LoginFlow = { verifier: string; state: string; nonce: string; returnTo: string };

export function authRoutes(onLogin: (user: User) => Promise<void>) {
  const auth = new Hono();

  // 1. Start: remember PKCE verifier + state + nonce (encrypted cookie), go to the login page.
  auth.get("/login", async (c) => {
    if (!AUTH_ENABLED) return c.redirect("/");
    const returnTo = c.req.query("returnTo") ?? "/";
    const flow: LoginFlow = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", // no open redirects
    };
    const sealed = await new EncryptJWT(flow).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setExpirationTime("10m").encrypt(flowKey());
    setCookie(c, "seyl_login", sealed, { httpOnly: true, secure: SECURE_COOKIES, sameSite: "Lax", path: "/api/auth", maxAge: 600 });

    const url = oidc.buildAuthorizationUrl(await provider(), {
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: "S256",
      state: flow.state,
      nonce: flow.nonce,
    });
    return c.redirect(url.href);
  });

  // 2. Back from the login page: exchange the code, verify the ID token, start a session.
  auth.get("/callback", async (c) => {
    const error = c.req.query("error");
    if (error) return c.redirect(`/?login_error=${encodeURIComponent(c.req.query("error_description") ?? error)}`);

    const sealed = getCookie(c, "seyl_login");
    if (!sealed) return c.redirect("/api/auth/login"); // flow expired or cookie lost: start over
    const flow = (await jwtDecrypt(sealed, flowKey())).payload as unknown as LoginFlow;
    deleteCookie(c, "seyl_login", { path: "/api/auth" });

    // openid-client checks state, PKCE, nonce, issuer, audience, expiry and the token signature.
    const callbackUrl = new URL(`${REDIRECT_URI}${new URL(c.req.url).search}`);
    const tokens = await oidc.authorizationCodeGrant(await provider(), callbackUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;
    const user: User = {
      sub: claims.sub,
      name: String(claims.name ?? claims.preferred_username ?? "User"),
      email: typeof claims.email === "string" ? claims.email : undefined,
      username: typeof claims.preferred_username === "string" ? claims.preferred_username : undefined,
    };

    const sessionId = randomBytes(32).toString("base64url");
    await sql`DELETE FROM auth_sessions WHERE expires_at < now()`; // tidy up old ones
    await sql`
      INSERT INTO auth_sessions (id_hash, sub, name, email, username, id_token, expires_at)
      VALUES (${hash(sessionId)}, ${user.sub}, ${user.name}, ${user.email ?? null}, ${user.username ?? null},
              ${tokens.id_token ?? ""}, now() + ${`${SESSION_HOURS} hours`}::interval)`;
    setCookie(c, "seyl_session", sessionId, { httpOnly: true, secure: SECURE_COOKIES, sameSite: "Lax", path: "/", maxAge: SESSION_HOURS * 3600 });
    await onLogin(user);
    console.log(`[auth] signed in: ${user.username ?? user.sub}`);
    return c.redirect(flow.returnTo);
  });

  // Who am I? (401 when signed out — the UI shows the login screen.)
  auth.get("/me", async (c) => {
    if (!AUTH_ENABLED) return c.json({ user: LOCAL_USER });
    const user = await sessionUser(c);
    return user ? c.json({ user: { sub: user.sub, name: user.name, email: user.email, username: user.username } }) : c.json({ error: "Not signed in" }, 401);
  });

  // Sign out here AND at Keycloak (otherwise "Sign in" would log straight back in).
  auth.post("/logout", async (c) => {
    const user = AUTH_ENABLED ? await sessionUser(c) : undefined;
    const id = getCookie(c, "seyl_session");
    if (id) await sql`DELETE FROM auth_sessions WHERE id_hash = ${hash(id)}`;
    deleteCookie(c, "seyl_session", { path: "/" });
    if (!user) return c.json({ logoutUrl: "/" });
    const logoutUrl = oidc.buildEndSessionUrl(await provider(), { post_logout_redirect_uri: `${PUBLIC_URL}/`, id_token_hint: user.idToken });
    return c.json({ logoutUrl: logoutUrl.href });
  });

  return auth;
}
