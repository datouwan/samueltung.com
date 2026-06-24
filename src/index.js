// samueltung.com Worker
// Static assets are served first (see wrangler.jsonc). This script only runs
// for unmatched paths — we expose a single World Cup data endpoint:
//
//   GET /api/wc  ->  { updated, source, groups[], matches[], live[] }
//
// Data sources (both proxied so tokens stay server-side):
//   • football-data.org  — standings + schedule (free tier, no daily cap, 10/min)
//   • api-football        — accurate LIVE score + minute (free tier: 100 req/day)
//
// To respect api-football's tiny daily quota, it is called ONLY while a match
// is actually live (football-data tells us that for free) and its response is
// cached longer than the football-data ones. If api-football is unavailable or
// out of quota, we fall back to football-data's (delayed) live score.

const FD = "https://api.football-data.org/v4/competitions/WC";
const AF = "https://v3.football.api-sports.io";
const WC_LEAGUE = 1;
const WC_SEASON = 2026;

const FD_TTL = 30; // football-data sub-cache (seconds)
const AF_TTL = 70; // api-football sub-cache — keeps us within 100/day on free
const LIVE_FD = ["LIVE", "IN_PLAY", "PAUSED"]; // football-data "live" statuses

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/wc") return handleWC(request, env, ctx);
    if (url.pathname === "/api/news") return handleNews(request, env, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

function json(data, status = 200, maxAge = 12) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      "access-control-allow-origin": "*",
    },
  });
}

// Fetch + JSON with an independent edge cache keyed by `keyStr`, so each
// upstream has its own TTL regardless of how often the page polls.
async function cachedJson(url, headers, ttl, keyStr) {
  const cache = caches.default;
  const key = new Request("https://wc.cache/" + encodeURIComponent(keyStr));
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const data = await r.json();
  await cache.put(
    key,
    new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    })
  );
  return data;
}

async function handleWC(request, env, ctx) {
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return json(
      { error: "missing_token", message: "FOOTBALL_DATA_TOKEN is not set on the Worker." },
      503,
      0
    );
  }

  const fdHeaders = { "X-Auth-Token": token };
  // yesterday→tomorrow (UTC) so a match in play across UTC midnight isn't missed
  const DAY = 86400000, now = Date.now();
  const from = new Date(now - DAY).toISOString().slice(0, 10);
  const to = new Date(now + DAY).toISOString().slice(0, 10);

  let standings, matchesRaw, scorersRaw;
  try {
    [standings, matchesRaw, scorersRaw] = await Promise.all([
      cachedJson(`${FD}/standings`, fdHeaders, FD_TTL, "fd-standings"),
      cachedJson(`${FD}/matches?dateFrom=${from}&dateTo=${to}`, fdHeaders, FD_TTL, `fd-matches-${from}`),
      cachedJson(`${FD}/scorers?limit=20`, fdHeaders, 300, "fd-scorers").catch(() => null),
    ]);
  } catch (err) {
    return json({ error: "upstream", message: String(err) }, 502, 0);
  }

  const groups = (standings.standings || [])
    .filter((s) => s.type === "TOTAL" && s.group)
    .map((s) => ({
      letter: groupLetter(s.group),
      table: (s.table || []).map((r) => ({
        position: r.position,
        name: r.team?.shortName || r.team?.name || "—",
        crest: r.team?.crest || "",
        played: r.playedGames, won: r.won, draw: r.draw, lost: r.lost,
        gd: r.goalDifference, points: r.points,
      })),
    }))
    .sort((a, b) => a.letter.localeCompare(b.letter));

  const matches = (matchesRaw.matches || []).map((m) => ({
    id: m.id,
    group: groupLetter(m.group),
    status: m.status, // SCHEDULED | TIMED | LIVE | IN_PLAY | PAUSED | FINISHED
    minute: m.minute ?? null,
    utcDate: m.utcDate,
    home: { name: m.homeTeam?.shortName || m.homeTeam?.name || "TBD", crest: m.homeTeam?.crest || "", score: m.score?.fullTime?.home },
    away: { name: m.awayTeam?.shortName || m.awayTeam?.name || "TBD", crest: m.awayTeam?.crest || "", score: m.score?.fullTime?.away },
  }));

  // group lookup by team pair, so api-football live games can be tagged A–L
  const groupByPair = {};
  matches.forEach((m) => { groupByPair[pairKey(m.home.name, m.away.name)] = m.group; });

  const fdLive = matches.filter((m) => LIVE_FD.includes(m.status));

  // Only spend api-football quota when something is actually live.
  let live = null, source = "football-data";
  if (fdLive.length && env.APIFOOTBALL_KEY) {
    try {
      // NOTE: the free plan rejects season-filtered queries for 2026, but the
      // plain live=all feed is allowed and includes current matches. We filter
      // to the World Cup (league id 1) in code below.
      const af = await cachedJson(
        `${AF}/fixtures?live=all`,
        { "x-apisports-key": env.APIFOOTBALL_KEY },
        AF_TTL,
        "af-live"
      );
      const errs = af && af.errors;
      const hasErr = Array.isArray(errs) ? errs.length > 0 : errs && Object.keys(errs).length > 0;
      if (hasErr) throw new Error("api-football: " + JSON.stringify(errs));
      const mapped = (af.response || [])
        .filter((f) => f.league?.id === WC_LEAGUE)
        .map((f) => {
          const hn = f.teams.home.name, an = f.teams.away.name;
          const short = f.fixture.status.short; // 1H,HT,2H,ET,BT,P,FT...
          const v = f.fixture.venue || {};
          return {
            status: "LIVE",
            minute: f.fixture.status.elapsed,
            phase: short,
            group: groupByPair[pairKey(hn, an)] || groupByPair[pairKey(an, hn)] || "",
            venue: { id: v.id || null, name: v.name || "", city: v.city || "" },
            home: { name: hn, crest: f.teams.home.logo || "", score: f.goals.home },
            away: { name: an, crest: f.teams.away.logo || "", score: f.goals.away },
          };
        });
      if (mapped.length) { live = mapped; source = "api-football"; }
    } catch (_) {
      // fall through to football-data below
    }
  }

  // Fallback: football-data's (delayed) live view
  if (!live) {
    live = fdLive.map((m) => ({
      status: m.status, minute: m.minute, phase: null, group: m.group,
      home: m.home, away: m.away,
    }));
  }

  const scorers = ((scorersRaw && scorersRaw.scorers) || []).map((s) => ({
    name: s.player?.name || "—",
    nationality: s.player?.nationality || "",
    team: s.team?.name || "",
    crest: s.team?.crest || "",
    goals: s.goals ?? 0,
    assists: s.assists ?? null,
    penalties: s.penalties ?? null,
  }));

  return json({ updated: new Date().toISOString(), source, groups, matches, live, scorers });
}

// World Cup news from publisher RSS feeds (free, keyless). Cached ~10 min.
// NOTE: Google News RSS blocks datacenter IPs (503 from Workers), so we use
// publisher feeds that allow server-side fetches. Guardian has a WC-2026 feed;
// BBC football is a filtered fallback.
const NEWS_FEEDS = [
  { url: "https://www.theguardian.com/football/world-cup-2026/rss", source: "The Guardian", filter: false },
  { url: "https://feeds.bbci.co.uk/sport/football/rss.xml", source: "BBC Sport", filter: true },
];

async function handleNews(request, env, ctx) {
  const cache = caches.default;
  const key = new Request("https://wc.cache/news");
  const hit = await cache.match(key);
  if (hit) return hit;

  for (const feed of NEWS_FEEDS) {
    try {
      const r = await fetch(feed.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; samueltung.com/1.0)" },
      });
      if (!r.ok) continue;
      const items = parseRss(await r.text(), feed);
      if (items.length) {
        const res = json({ updated: new Date().toISOString(), source: feed.source, items }, 200, 600);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
    } catch (_) {
      // try the next feed
    }
  }
  return json({ error: "news_unavailable" }, 502, 0);
}

function parseRss(xml, feed) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 20) {
    const block = m[1];
    const grab = (tag) => {
      const t = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return t ? decodeXml(t[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : "";
    };
    const title = grab("title"), link = grab("link"), pubDate = grab("pubDate");
    if (!title || !link) continue;
    if (feed.filter && !/world cup|2026/i.test(title)) continue;
    items.push({ title, source: feed.source, link, pubDate });
  }
  return items;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function groupLetter(g) {
  if (!g) return "";
  const m = String(g).match(/GROUP[_\s]?([A-Z])/i);
  return m ? m[1].toUpperCase() : "";
}

// normalize a name for cross-source matching (mirror of the frontend's norm)
const ALIAS = {
  korearepublic: "southkorea", republicofkorea: "southkorea", koreasouth: "southkorea",
  iriran: "iran", caboverde: "capeverde", congodr: "drcongo", congodrc: "drcongo",
  bosniaandherzegovina: "bosniaherzegovina", turkey: "turkiye",
  usa: "unitedstates", unitedstatesofamerica: "unitedstates", us: "unitedstates",
};
function norm(s) {
  const k = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIAS[k] || k;
}
function pairKey(a, b) { return norm(a) + "|" + norm(b); }
