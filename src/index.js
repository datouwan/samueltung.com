// samueltung.com Worker
// Static assets are served first (see wrangler.jsonc). This script only runs
// for unmatched paths — we use it to expose a single World Cup data endpoint:
//
//   GET /api/wc  ->  { updated, groups[], matches[] }
//
// It proxies football-data.org (free tier includes competition "WC"), keeping
// the API token server-side and caching responses so we stay under the
// free-tier rate limit (10 req/min).

const API = "https://api.football-data.org/v4/competitions/WC";
const CACHE_SECONDS = 25;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/wc") {
      return handleWC(request, env, ctx);
    }

    // Anything else that reached the Worker isn't a static asset → 404 page.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

function json(data, status = 200, maxAge = CACHE_SECONDS) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });
}

async function handleWC(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/wc", request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    // Page handles this gracefully and keeps showing the map.
    return json(
      { error: "missing_token", message: "FOOTBALL_DATA_TOKEN is not set on the Worker." },
      503,
      0
    );
  }

  const headers = { "X-Auth-Token": token };
  // Window of yesterday→tomorrow (UTC) so a match that kicked off before UTC
  // midnight but is still in play (e.g. at halftime) isn't missed.
  const DAY = 86400000;
  const now = Date.now();
  const from = new Date(now - DAY).toISOString().slice(0, 10);
  const to = new Date(now + DAY).toISOString().slice(0, 10);

  try {
    const [standingsRes, matchesRes] = await Promise.all([
      fetch(`${API}/standings`, { headers }),
      fetch(`${API}/matches?dateFrom=${from}&dateTo=${to}`, { headers }),
    ]);

    if (!standingsRes.ok || !matchesRes.ok) {
      const code = standingsRes.ok ? matchesRes.status : standingsRes.status;
      return json({ error: "upstream", status: code }, 502, 0);
    }

    const standings = await standingsRes.json();
    const matchesRaw = await matchesRes.json();

    const groups = (standings.standings || [])
      .filter((s) => s.type === "TOTAL" && s.group)
      .map((s) => ({
        letter: groupLetter(s.group),
        table: (s.table || []).map((r) => ({
          position: r.position,
          name: r.team?.shortName || r.team?.name || "—",
          crest: r.team?.crest || "",
          played: r.playedGames,
          won: r.won,
          draw: r.draw,
          lost: r.lost,
          gd: r.goalDifference,
          points: r.points,
        })),
      }))
      .sort((a, b) => a.letter.localeCompare(b.letter));

    const matches = (matchesRaw.matches || []).map((m) => ({
      id: m.id,
      group: groupLetter(m.group),
      status: m.status, // SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED
      minute: m.minute ?? null,
      utcDate: m.utcDate,
      home: {
        name: m.homeTeam?.shortName || m.homeTeam?.name || "TBD",
        crest: m.homeTeam?.crest || "",
        score: m.score?.fullTime?.home,
      },
      away: {
        name: m.awayTeam?.shortName || m.awayTeam?.name || "TBD",
        crest: m.awayTeam?.crest || "",
        score: m.score?.fullTime?.away,
      },
    }));

    const res = json({ updated: new Date().toISOString(), groups, matches });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return json({ error: "fetch_failed", message: String(err) }, 502, 0);
  }
}

function groupLetter(g) {
  // "GROUP_A" -> "A"
  if (!g) return "";
  const m = String(g).match(/GROUP[_\s]?([A-Z])/i);
  return m ? m[1].toUpperCase() : "";
}
