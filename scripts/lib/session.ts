import { CSRF_HEADER } from "../../shared/chat.js";

// A minimal "browser" for scripts: a cookie jar, manual redirects, and the full OIDC
// sign-in flow (app → Keycloak form → credentials → callback → session cookie).

export class Session {
  readonly cookies = new Map<string, string>();
  constructor(readonly app: string) {}

  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...(init.headers as Record<string, string>), Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
    const res = await fetch(url, { ...init, redirect: "manual", headers });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value && !/max-age=0|expires=thu, 01 jan 1970/i.test(cookie)) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return res;
  }

  // Calls to the app's API, relative to /api (with the anti-CSRF header, like the web UI).
  api(path: string, init: RequestInit = {}) {
    return this.go(`${this.app}/api${path}`, { ...init, headers: { [CSRF_HEADER]: "1", ...(init.headers as Record<string, string>) } });
  }

  async signIn(username: string, password: string): Promise<Response> {
    let res = await this.go(`${this.app}/api/auth/login`);
    res = await this.go(res.headers.get("location")!);
    const form = /<form[^>]+action="([^"]+)"/.exec(await res.text())?.[1]?.replace(/&amp;/g, "&");
    if (!form) throw new Error("Login form not found");
    res = await this.go(form, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password }),
    });
    const next = res.headers.get("location");
    if (!next?.includes("/api/auth/callback")) throw new Error(`Sign-in failed for ${username}`);
    return this.go(next);
  }
}
