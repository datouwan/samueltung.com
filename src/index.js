// samueltung.com Worker — entry point.
//
// Static assets in ./public are served first (see wrangler.jsonc); this script
// only runs for unmatched paths. It does two things:
//   1. Redirect the legacy World Cup URL to its new feature folder.
//   2. Route /api/* to the World Cup feature module, else fall back to assets.
//
// Feature code lives in src/worldcup/. Add future features as sibling modules
// and route them here.

import { handleWorldCupApi } from "./worldcup/api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Legacy path → new feature folder (keeps old links / bookmarks working).
    if (url.pathname === "/worldcup2026" || url.pathname === "/worldcup2026.html") {
      const to = new URL(url);
      to.pathname = "/worldcup";
      return Response.redirect(to.toString(), 301);
    }

    const api = await handleWorldCupApi(request, env, ctx);
    if (api) return api;

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
