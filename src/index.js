// samueltung.com Worker — entry point.
//
// The Worker runs before static assets (assets.run_worker_first in
// wrangler.jsonc) so it can gate the whole site behind a password. Everything
// is protected with HTTP Basic Auth EXCEPT the public World Cup feature
// (/worldcup and its /api/* endpoints).
//
// The password is the SITE_PASSWORD secret (any username works; only the
// password is checked). Set it with:  npx wrangler secret put SITE_PASSWORD
//
// Feature code lives in src/worldcup/. Add future features as sibling modules
// and route them here.

import { handleWorldCupApi } from "./worldcup/api.js";

// Paths that stay public (no password): the World Cup page and its API.
function isPublicPath(pathname) {
  return pathname === "/worldcup"
    || pathname.startsWith("/worldcup/")
    || pathname.startsWith("/api/");
}

// Returns a Response when access should be denied, or null when authorized.
function checkAuth(request, env) {
  const expected = env.SITE_PASSWORD;
  if (!expected) {
    // Fail closed: don't expose the site until a password is configured.
    return new Response("Site password is not configured yet.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try { decoded = atob(header.slice(6)); } catch (_) { /* malformed header */ }
    const sep = decoded.indexOf(":");
    const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    if (pass === expected) return null; // authorized
  }
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="samueltung.com", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Legacy path → new feature folder (keeps old links / bookmarks working).
    if (url.pathname === "/worldcup2026" || url.pathname === "/worldcup2026.html") {
      const to = new URL(url);
      to.pathname = "/worldcup";
      return Response.redirect(to.toString(), 301);
    }

    // Gate everything except the public World Cup feature.
    if (!isPublicPath(url.pathname)) {
      const denied = checkAuth(request, env);
      if (denied) return denied;
    }

    const api = await handleWorldCupApi(request, env, ctx);
    if (api) return api;

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
