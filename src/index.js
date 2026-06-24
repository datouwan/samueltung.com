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
    if (url.pathname === "/api/player") return handlePlayer(request, env, ctx);
    if (url.pathname === "/api/events") return handleEvents(request, env, ctx);
    if (url.pathname === "/api/wiki") return handleWiki(request, env, ctx);
    if (url.pathname === "/api/records") return handleRecords(request, env, ctx);
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
      cachedJson(`${FD}/scorers?limit=60`, fdHeaders, 300, "fd-scorers-60").catch(() => null),
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
        gf: r.goalsFor ?? null, ga: r.goalsAgainst ?? null,
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
            fixtureId: f.fixture.id || null,
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
  { url: "https://www.skysports.com/rss/12040", source: "Sky Sports", filter: true },
  { url: "https://www.cbssports.com/rss/headlines/soccer/", source: "CBS Sports", filter: true },
  { url: "https://talksport.com/football/feed/", source: "talkSPORT", filter: true },
];

async function handleNews(request, env, ctx) {
  const cache = caches.default;
  const key = new Request("https://wc.cache/news");
  const hit = await cache.match(key);
  if (hit) return hit;

  // fetch all feeds in parallel; a slow/dead feed just contributes nothing
  const lists = await Promise.all(NEWS_FEEDS.map(async (feed) => {
    try {
      const r = await fetch(feed.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; samueltung.com/1.0)" },
      });
      if (!r.ok) return [];
      return parseRss(await r.text(), feed);
    } catch (_) {
      return [];
    }
  }));

  // merge, dedupe by title, sort newest first
  const seen = new Set();
  const items = lists.flat().filter((it) => {
    const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)).slice(0, 24);

  if (!items.length) return json({ error: "news_unavailable" }, 502, 0);
  const res = json({ updated: new Date().toISOString(), items }, 200, 600);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
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

// Player bio + photo from api-football's profiles endpoint (free plan allows it,
// no season filter). Cached 24h per surname — bios are static, so this barely
// touches the daily quota. Returns 200 with {error} on failure so the page can
// still show the stats it already has.
async function handlePlayer(request, env, ctx) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") || "").trim();
  const nat = (url.searchParams.get("nat") || "").trim();
  if (!name) return json({ error: "no_name" }, 400, 0);
  if (!env.APIFOOTBALL_KEY) return json({ error: "no_key" }, 200, 0);

  const last = name.split(/\s+/).pop().toLowerCase();
  // api-football's search expects ASCII, so strip accents (Mbappé -> mbappe)
  const term = last.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (term.length < 3) return json({ error: "short" }, 200, 0);

  // cache the final (small) result per surname+nationality; never cache errors
  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/player4-${term}-${norm(nat)}`);
  const cached = await cache.match(ckey);
  if (cached) return cached;

  try {
    const r = await fetch(`${AF}/players/profiles?search=${encodeURIComponent(term)}`, {
      headers: { "x-apisports-key": env.APIFOOTBALL_KEY },
    });
    if (!r.ok) return json({ error: "upstream" }, 200, 0);
    const data = await r.json();
    const errs = data && data.errors;
    if (Array.isArray(errs) ? errs.length : errs && Object.keys(errs).length)
      return json({ error: "rate_limited" }, 200, 0);

    // token-based match: api-football names can be compound (e.g. lastname
    // "Messi Cuccittini"), so build a haystack and count how many of our name
    // tokens appear in it. Surname must be present; nationality breaks ties.
    const tokens = name.toLowerCase().split(/\s+/).map(norm).filter((t) => t.length >= 2);
    const surname = norm(last);
    const first = tokens[0] || "";
    let best = null, bestScore = 0;
    for (const r of data.response || []) {
      const p = r.player; if (!p) continue;
      const hay = norm(`${p.firstname || ""} ${p.lastname || ""} ${p.name || ""}`);
      if (!hay.includes(surname)) continue; // surname is mandatory
      const natMatch = nat && norm(p.nationality) === norm(nat);
      // for multi-word names, the first name (or nationality) must also match,
      // so "Gerd Müller" can't silently fall back to "Thomas Müller"
      if (tokens.length > 1 && first && !hay.includes(first) && !natMatch) continue;
      let score = tokens.reduce((n, t) => n + (hay.includes(t) ? 2 : 0), 0);
      if (natMatch) score += 3;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return json({ error: "not_found" }, 200, 0);

    // full club history from career teams (national team excluded), newest first
    let clubs = [];
    try {
      const tr = await fetch(`${AF}/players/teams?player=${best.id}`, {
        headers: { "x-apisports-key": env.APIFOOTBALL_KEY },
      });
      if (tr.ok) {
        const td = await tr.json();
        clubs = (td.response || [])
          .filter((x) => x.team && norm(x.team.name) !== norm(best.nationality))
          .map((x) => {
            const seasons = (x.seasons || []).filter((s) => typeof s === "number");
            return {
              name: x.team.name, logo: x.team.logo || "",
              from: seasons.length ? Math.min(...seasons) : null,
              to: seasons.length ? Math.max(...seasons) : null,
            };
          })
          .filter((c) => c.from != null)
          .sort((a, b) => b.to - a.to || b.from - a.from);
      }
    } catch (_) { /* clubs are optional */ }

    const res = json({
      name: best.name, firstname: best.firstname, lastname: best.lastname,
      photo: best.photo || "", nationality: best.nationality || "",
      club: clubs[0] ? clubs[0].name : "", clubs,
      birthDate: (best.birth && best.birth.date) || "", birthPlace: (best.birth && best.birth.place) || "",
      birthCountry: (best.birth && best.birth.country) || "",
      age: best.age ?? null, height: best.height || "", weight: best.weight || "",
      position: best.position || "", number: best.number ?? null,
    }, 200, 86400);
    ctx.waitUntil(cache.put(ckey, res.clone()));
    return res;
  } catch (_) {
    return json({ error: "failed" }, 200, 0);
  }
}

// Goal events for one fixture (lazy — only when a live match card is opened).
// Cached ~45s so repeated opens during a match don't burn quota.
async function handleEvents(request, env, ctx) {
  const url = new URL(request.url);
  const fid = url.searchParams.get("fixture") || "";
  if (!/^\d+$/.test(fid)) return json({ error: "bad_fixture" }, 400, 0);
  if (!env.APIFOOTBALL_KEY) return json({ error: "no_key" }, 200, 0);

  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/events-${fid}`);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  try {
    const r = await fetch(`${AF}/fixtures/events?fixture=${fid}`, {
      headers: { "x-apisports-key": env.APIFOOTBALL_KEY },
    });
    if (!r.ok) return json({ error: "upstream" }, 200, 0);
    const d = await r.json();
    const errs = d && d.errors;
    if (Array.isArray(errs) ? errs.length : errs && Object.keys(errs).length)
      return json({ error: "rate_limited" }, 200, 0);
    const goals = (d.response || [])
      .filter((e) => e.type === "Goal" && e.detail !== "Missed Penalty")
      .map((e) => ({
        minute: e.time.elapsed, extra: e.time.extra ?? null,
        player: (e.player && e.player.name) || "", team: (e.team && e.team.name) || "",
        detail: e.detail || "", assist: (e.assist && e.assist.name) || "",
      }));
    const res = json({ fixture: Number(fid), goals }, 200, 45);
    ctx.waitUntil(cache.put(ckey, res.clone()));
    return res;
  } catch (_) {
    return json({ error: "failed" }, 200, 0);
  }
}

// Fuzzy player lookup via Wikipedia (free, keyless, unlimited). Returns a list
// of candidate footballers with photo + summary. Cached 24h per query.
async function handleWiki(request, env, ctx) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim();
  const kind = u.searchParams.get("kind") === "team" ? "team" : "player";
  if (q.length < 2) return json({ results: [] }, 200, 0);

  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/wiki-${kind}-${q.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  const suffix = kind === "team" ? " national football team" : " footballer";
  const keep = kind === "team" ? /national.*football team|national team/i : /footballer/i;
  try {
    const api = "https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search" +
      `&gsrsearch=${encodeURIComponent(q + suffix)}&gsrlimit=6` +
      "&prop=pageimages%7Cextracts%7Cdescription&exintro=1&explaintext=1&exsentences=3" +
      "&piprop=thumbnail&pithumbsize=400&redirects=1";
    const r = await fetch(api, { headers: { "user-agent": "samueltung.com/1.0 (World Cup map)" } });
    if (!r.ok) return json({ results: [] }, 200, 0);
    const d = await r.json();
    const pages = Object.values((d.query && d.query.pages) || {});
    pages.sort((a, b) => (a.index || 99) - (b.index || 99));
    const all = pages.filter((p) => p.title).map((p) => ({
      title: p.title, description: p.description || "", extract: p.extract || "",
      thumbnail: p.thumbnail ? p.thumbnail.source : "",
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
    }));
    const matched = all.filter((p) => keep.test(p.description) || keep.test(p.title));
    const results = (matched.length ? matched : all).slice(0, 6);
    const res = json({ results }, 200, 86400);
    ctx.waitUntil(cache.put(ckey, res.clone()));
    return res;
  } catch (_) {
    return json({ results: [] }, 200, 0);
  }
}

// All-time records scraped from Wikipedia (free, unlimited). Player top
// scorers already include 2026 (the article updates live). Cached 6h, with a
// graceful empty payload on failure so the page falls back to curated values.
async function handleRecords(request, env, ctx) {
  const cache = caches.default;
  const ckey = new Request("https://wc.cache/records-v1");
  const hit = await cache.match(ckey);
  if (hit) return hit;
  try {
    const [scHtml, recHtml] = await Promise.all([
      wikiPageHtml("List_of_FIFA_World_Cup_top_goalscorers"),
      wikiPageHtml("FIFA_World_Cup_records_and_statistics"),
    ]);
    const topScorers = parseTopScorers(scHtml);
    const teams = parseTeamRecords(recHtml);
    const data = { source: "wikipedia", updated: new Date().toISOString(), topScorers, ...teams };
    const res = json(data, 200, 21600);
    ctx.waitUntil(cache.put(ckey, res.clone()));
    return res;
  } catch (e) {
    return json({ error: "records_failed", message: String(e) }, 200, 0);
  }
}
async function wikiPageHtml(page) {
  const r = await fetch(
    `https://en.wikipedia.org/w/api.php?action=parse&format=json&page=${page}&prop=text&formatversion=2`,
    { headers: { "user-agent": "samueltung.com/1.0 (World Cup map)" } }
  );
  if (!r.ok) throw new Error("wiki " + r.status);
  const d = await r.json();
  return (d.parse && d.parse.text) || "";
}
const WENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&minus;": "-", "&ndash;": "–" };
function wtidy(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, (m) => WENT[m] || " ")
    .replace(/\[[^\]]*\]/g, "").replace(/[♦†‡*]/g, "").replace(/\s+/g, " ").trim();
}
const wTables = (html) => html.match(/<table[^>]*wikitable[^>]*>[\s\S]*?<\/table>/g) || [];
const wRows = (t) => t.match(/<tr>[\s\S]*?<\/tr>/g) || [];
function wCells(r) { const o = []; const re = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g; let m; while ((m = re.exec(r))) o.push(wtidy(m[1])); return o; }
const findTable = (tables, ...keys) => tables.find((t) => { const h = wtidy(wRows(t)[0] || "").toLowerCase(); return keys.every((k) => h.includes(k)); });
const cleanTeam = (s) => s.replace(/\s*\([^)]*\)/g, "").replace(/\s+note\s+\d+/gi, "").trim();

function parseTopScorers(html) {
  const t = findTable(wTables(html), "goals scored", "matches played", "goals per match");
  if (!t) return [];
  let lastRank = null, lastGoals = null;
  const out = [];
  for (const r of wRows(t).slice(1)) {
    const c = wCells(r);
    if (c.length < 3) continue;
    let rank, player, team, goals, toff;
    if (/^\d+$/.test(c[0])) { rank = +c[0]; player = c[1]; team = c[2]; goals = +c[3]; toff = 6; lastRank = rank; lastGoals = goals; }
    else { rank = lastRank; player = c[0]; team = c[1]; goals = lastGoals; toff = 4; }
    if (!player || !Number.isFinite(goals)) continue;
    const yrs = (c[toff] || "").match(/\d{4}/g) || [];
    out.push({ rank, player, team: cleanTeam(team), goals, last: yrs.length ? +yrs[yrs.length - 1] : null });
    if (out.length >= 20) break;
  }
  return out;
}
function parseTeamRecords(html) {
  const tables = wTables(html);
  const titles = [];
  const medal = findTable(tables, "gold", "silver", "bronze");
  if (medal) for (const r of wRows(medal).slice(1)) {
    const c = wCells(r);
    if (c.length < 6 || !/^\d+$/.test(c[0])) continue;
    titles.push({ name: cleanTeam(c[1]), gold: +c[2], silver: +c[3], bronze: +c[4] });
    if (titles.length >= 8) break;
  }
  const recs = findTable(tables, "part", "gf", "ga", "pts");
  let teamGoals = [], teamApps = [];
  if (recs) {
    const arr = [];
    for (const r of wRows(recs).slice(1)) {
      const c = wCells(r);
      if (c.length < 11 || !/^\d+$/.test(c[0])) continue;
      arr.push({ name: cleanTeam(c[1]), part: +c[2], gf: +c[7] });
    }
    teamGoals = [...arr].sort((a, b) => b.gf - a.gf).slice(0, 8).map((x) => ({ name: x.name, val: x.gf }));
    teamApps = [...arr].sort((a, b) => b.part - a.part).slice(0, 8).map((x) => ({ name: x.name, val: x.part }));
  }
  return { titles, teamGoals, teamApps };
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
