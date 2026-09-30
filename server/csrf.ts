import { createMiddleware } from "hono/factory";
import { CSRF_HEADER } from "../shared/chat.js";

// Cross-site request forgery (CSRF): another page making the browser send a request to
// our api — with the user's session cookie attached. SameSite=Lax cookies already stop
// most of it; this closes the rest (e.g. pages on another localhost port count as the
// same "site", and forms can still POST in some cases).
//
// Every state-changing request must carry a custom header. A page on another origin can
// only add one after a CORS preflight, and the api allows none — so only our own UI
// (and scripts, which have no cookies to abuse) can pass. Browsers also say where a request
// comes from (Sec-Fetch-Site); anything but our own origin is refused.
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

export const csrfGuard = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.includes(c.req.method)) return next();
  const site = c.req.header("sec-fetch-site");
  if (c.req.header(CSRF_HEADER) !== "1" || (site !== undefined && site !== "same-origin")) {
    return c.json({ error: "Request refused (cross-site request protection)" }, 403);
  }
  return next();
});
