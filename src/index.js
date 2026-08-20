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
import { handleTrainMonApi } from "./trainmon/api.js";

// Paths that stay public (no password): project pages and public APIs.
function isPublicPath(pathname) {
  return pathname === "/ai-omr"
    || pathname.startsWith("/ai-omr/")
    || pathname === "/ai-omr-agnostic"
    || pathname.startsWith("/ai-omr-agnostic/")
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
          <p>Track A is in the M9.5 real-photo development cycle. Track B's deterministic representation foundation is complete, while neural vocabulary expansion remains behind the real-photo recognition gate.</p>
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
              <li style="padding:7px 0"><strong style="color:#15221f">M9.5 now:</strong> parameter-free dual-view inference is the frozen development lead.</li>
              <li style="padding:7px 0">Clean/camera gates pass at TER 0.06976 / 0.06581.</li>
              <li style="padding:7px 0">Real-photo development TER improves to 0.2187 with 3/60 exact systems.</li>
              <li style="padding:7px 0">Next derive and audit training-only staff-relative notehead and accidental labels.</li>
              <li style="padding:7px 0">Propose an auxiliary localization head only if the label audit passes.</li>
            </ol>
            <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Gate:</strong> freeze M9.5, preserve the 383-token V1 target and decoder, and reserve a new independent benchmark for the next final claim.</p>
          </article>

          <article class="card" style="padding:34px;border-top:5px solid #1e6b55">
            <div style="display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:22px">
              <div>
                <p class="eyebrow" style="margin-bottom:5px">Track B · Score semantics</p>
                <h3 style="margin:0;font:500 1.7rem/1.08 Georgia,serif">Score IR → faithful notation</h3>
              </div>
              <span style="padding:6px 10px;border-radius:999px;background:#bfe7d5;color:#10483a;font-size:.72rem;font-weight:900">FOUNDATION COMPLETE</span>
            </div>
            <ol style="margin:0;padding-left:21px;color:#5d6a66">
              <li style="padding:7px 0"><strong style="color:#15221f">Conformance complete:</strong> deterministic Score IR v2 + round-trip rendering.</li>
              <li style="padding:7px 0">Chords/double stops, explicit beams, displayed accidentals, and per-note fingering.</li>
              <li style="padding:7px 0">Slurs, articulations, bowing techniques, and exact tuplets.</li>
              <li style="padding:7px 0">Event-onset dynamics and deterministic multiple voices.</li>
              <li style="padding:7px 0">One rights-clean fixture combines and renders every supported relationship.</li>
            </ol>
            <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Renderer decision:</strong> keep MusicXML + Verovio. Representation is ready; model-target expansion remains gated by Track A.</p>
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
            <h2>Score IR v2 now preserves the notation Verovio must render.</h2>
          </div>
          <p>The deterministic conformance pass is complete: rich note relationships survive Score IR, MusicXML round trip, and Verovio rendering without changing the neural vocabulary.</p>
        </div>
        <div class="grid scope">
          <article class="card" style="padding:34px">
            <h3 style="margin:0 0 14px">Rendering stack retained</h3>
            <p style="margin:0;color:#5d6a66">MusicXML + Verovio now round-trip and visibly render the complete bounded Score IR v2 feature set.</p>
          </article>
          <article class="card" style="padding:34px;background:#bfe7d5;border-color:transparent">
            <h3 style="margin:0 0 14px;color:#10483a">Representation-only handoff complete</h3>
            <p style="margin:0 0 16px;color:#10483a">The conformance fixture combines chords, beams, displayed accidentals, fingerings, relationships, tuplets, dynamics, and two voices in one rights-clean rendered score.</p>
            <a href="/ai-omr/score-ir/" style="font-weight:850;color:#10483a">Read the Score IR v2 architecture note →</a>
          </article>
        </div>
        <p style="margin:22px 0 0;color:#5d6a66"><strong style="color:#15221f">Sequencing rule:</strong> deterministic Track B representation may remain complete, but no v2 tokenizer or neural target expansion begins until Track A clears a credible independent real-photo gate.</p>
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

    const trainApi = await handleTrainMonApi(request, env);
    if (trainApi) return trainApi;

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
