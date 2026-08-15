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

import { handleWorldCupApi } from "./worldcup/api.js";

// Paths that stay public (no password): project pages and public APIs.
function isPublicPath(pathname) {
  return pathname === "/ai-omr"
    || pathname.startsWith("/ai-omr/")
    || pathname === "/worldcup"
    || pathname.startsWith("/worldcup/")
    || pathname === "/ai-omr-deepseek"
    || pathname.startsWith("/ai-omr-deepseek/")
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
    <section id="development-tracks" style="padding:72px 0;background:#f4f0e7;border-top:1px solid #d9d4c8">
      <div class="wrap">
        <div class="section-head">
          <div>
            <p class="eyebrow">Updated development plan · August 2026</p>
            <h2>Two tracks. One product pipeline.</h2>
          </div>
          <p>Yesterday's plan was mostly a single recognition ladder. The project is now split intentionally: Track A proves the AI can read the score; Track B proves the product can represent and faithfully re-render richer notation.</p>
        </div>

        <div class="grid scope" style="align-items:stretch">
          <article class="card" style="padding:34px;border-top:5px solid #e26f51">
            <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px">
              <div>
                <p class="eyebrow" style="margin-bottom:5px;color:#e26f51">Track A · Recognition</p>
                <h3 style="margin:0;font:500 1.7rem/1.08 Georgia,serif">Image → correct musical content</h3>
              </div>
              <span style="padding:6px 10px;border-radius:999px;background:#f3d9d1;color:#8f402d;font-size:.72rem;font-weight:900">ACTIVE</span>
            </div>
            <ol style="margin:0;padding-left:21px;color:#5d6a66">
              <li style="padding:7px 0"><strong style="color:#15221f">M8 now:</strong> genuine image conditioning, not template collapse.</li>
              <li style="padding:7px 0">Improve key/time/pickup/measure/event supervision.</li>
              <li style="padding:7px 0">Improve pitch + duration accuracy and exact event/measure counts.</li>
              <li style="padding:7px 0">Produce the first exact systems on the untouched clean benchmark.</li>
              <li style="padding:7px 0">Only after that: scale the corpus and add camera/photo augmentation.</li>
            </ol>
            <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Gate:</strong> do not expand the neural target vocabulary to rich notation until the current V1 recognizer proves real visual understanding.</p>
          </article>

          <article class="card" style="padding:34px;border-top:5px solid #1e6b55">
            <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px">
              <div>
                <p class="eyebrow" style="margin-bottom:5px">Track B · Score semantics</p>
                <h3 style="margin:0;font:500 1.7rem/1.08 Georgia,serif">Score IR → faithful notation</h3>
              </div>
              <span style="padding:6px 10px;border-radius:999px;background:#bfe7d5;color:#10483a;font-size:.72rem;font-weight:900">PARALLEL</span>
            </div>
            <ol style="margin:0;padding-left:21px;color:#5d6a66">
              <li style="padding:7px 0"><strong style="color:#15221f">Foundation now:</strong> deterministic Score IR v2 + round-trip tests.</li>
              <li style="padding:7px 0">Add chord / violin double-stop representation.</li>
              <li style="padding:7px 0">Add explicit beam groups, levels, and beam hooks.</li>
              <li style="padding:7px 0">Preserve displayed accidentals separately from sounding pitch.</li>
              <li style="padding:7px 0">Attach fingering to the correct note inside a chord.</li>
            </ol>
            <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Renderer decision:</strong> keep MusicXML + Verovio. The missing layer is semantic structure, not engraving capability.</p>
          </article>
        </div>

        <div style="margin-top:20px;padding:28px 32px;border-radius:20px;background:#10483a;color:white">
          <p class="eyebrow" style="color:#bfe7d5;margin-bottom:8px">Convergence milestone</p>
          <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:9px;align-items:center;text-align:center;font-size:.8rem">
            <div style="padding:14px 8px;border:1px solid rgba(255,255,255,.16);border-radius:12px"><strong>Photo</strong></div>
            <div style="color:#bfe7d5;font-weight:900">→</div>
            <div style="padding:14px 8px;border:1px solid rgba(255,255,255,.16);border-radius:12px"><strong>Track A<br>AI recognition</strong></div>
            <div style="color:#bfe7d5;font-weight:900">→</div>
            <div style="padding:14px 8px;border:1px solid rgba(255,255,255,.16);border-radius:12px"><strong>Track B<br>Score IR v2</strong></div>
            <div style="color:#bfe7d5;font-weight:900">→</div>
            <div style="padding:14px 8px;border:1px solid rgba(255,255,255,.16);border-radius:12px"><strong>MusicXML<br>+ Verovio</strong></div>
          </div>
          <p style="margin:18px 0 0;color:#c4d4ce">The tracks join when the recognizer can emit reliable semantic events into Score IR v2. That unlocks arbitrary teacher-provided sheet music → structured score → interactive practice and later performance feedback.</p>
        </div>
      </div>
    </section>

    <section id="score-ir-v2" style="padding:72px 0;background:#fffdf8;border-top:1px solid #d9d4c8;border-bottom:1px solid #d9d4c8">
      <div class="wrap">
        <div class="section-head">
          <div>
            <p class="eyebrow">Track B architecture note</p>
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
        <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Sequencing rule:</strong> Track B may be designed and round-trip tested in parallel, but Track A remains the active model-training gate until genuine image conditioning produces credible exact systems.</p>
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
};
