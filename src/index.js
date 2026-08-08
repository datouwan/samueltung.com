// samueltung.com Worker — entry point.
//
// The Worker runs before static assets (assets.run_worker_first in
// wrangler.jsonc) so it can gate the whole site behind a password. Everything
// is protected with HTTP Basic Auth EXCEPT explicitly public project pages
// (/ai-omr, /worldcup, and the public /api/* endpoints).
//
// The password is the SITE_PASSWORD secret (any username works; only the
// password is checked). Set it with:  npx wrangler secret put SITE_PASSWORD
//
// Feature code lives in src/worldcup/. Add future features as sibling modules
// and route them here.

import { handleWorldCupApi, warmSquads } from "./worldcup/api.js";

// Paths that stay public (no password): project pages and public APIs.
function isPublicPath(pathname) {
  return pathname === "/ai-omr"
    || pathname.startsWith("/ai-omr/")
    || pathname === "/worldcup"
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

function decorateAiOmrPlan(response) {
  const update = `
    <section id="score-ir-v2" style="padding:72px 0;background:#fffdf8;border-top:1px solid #d9d4c8;border-bottom:1px solid #d9d4c8">
      <div class="wrap">
        <div class="section-head">
          <div>
            <p class="eyebrow">Architecture update · August 2026</p>
            <h2>Verovio can render it. The Score IR cannot — yet.</h2>
          </div>
          <p>The next semantic milestone is not a new renderer. It is a richer intermediate representation for chords/double stops, explicit beam groups, printed accidentals, and per-note fingerings.</p>
        </div>
        <div class="grid scope">
          <article class="card" style="padding:34px">
            <h3 style="margin:0 0 14px">Keep the rendering stack</h3>
            <p style="margin:0;color:#5d6a66">MusicXML + Verovio already cover the rich notation needed for violin practice. Keep the renderer and upgrade the contract between model output and MusicXML.</p>
          </article>
          <article class="card" style="padding:34px;background:#bfe7d5;border-color:transparent">
            <h3 style="margin:0 0 14px;color:#10483a">Score IR v2 first target</h3>
            <p style="margin:0 0 16px;color:#10483a">Represent the real-world sample that triggered this update: a beamed dotted-eighth + sixteenth figure with violin double stops, stacked fingerings, and a printed sharp.</p>
            <a href="/ai-omr/score-ir/" style="font-weight:850;color:#10483a">Read the Score IR v2 architecture note →</a>
          </article>
        </div>
        <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Sequencing rule:</strong> do not derail the active M8 recognition gate. Design and round-trip test Score IR v2 in parallel, but keep model-training scope on the current rhythm-clean V1 benchmark until genuine image conditioning produces credible exact systems.</p>
      </div>
    </section>`;

  return new HTMLRewriter()
    .on("main", {
      element(element) {
        element.append(update, { html: true });
      },
    })
    .transform(response);
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

    // Gate everything except the public project pages and APIs.
    if (!isPublicPath(url.pathname)) {
      const denied = checkAuth(request, env);
      if (denied) return denied;
    }

    const api = await handleWorldCupApi(request, env, ctx);
    if (api) return api;

    if (env.ASSETS) {
      const asset = await env.ASSETS.fetch(request);
      if (url.pathname === "/ai-omr/" && asset.headers.get("content-type")?.includes("text/html")) {
        return decorateAiOmrPlan(asset);
      }
      return asset;
    }
    return new Response("Not found", { status: 404 });
  },

  // Cron: keep every nation's api-football squad warm in cache so the Squads tab
  // consistently serves real player photos (see triggers.crons in wrangler.jsonc).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warmSquads(env));
  },
};
