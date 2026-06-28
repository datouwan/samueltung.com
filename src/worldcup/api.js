// World Cup 2026 feature — API handlers.
// All /api/* endpoints used by public/worldcup/index.html live here; src/index.js
// is just the Worker entry that routes to handleWorldCupApi() below.
//
//   GET /api/wc       ->  { updated, source, groups[], matches[], live[], scorers[] }
//   GET /api/news     ->  { updated, items[] }              (publisher RSS)
//   GET /api/player   ->  player bio + club history          (api-football)
//   GET /api/events   ->  goal events for one fixture        (api-football)
//   GET /api/wiki     ->  fuzzy player/team lookup           (Wikipedia)
//   GET /api/records  ->  all-time records                   (Wikipedia)
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

const FD_TTL = 30; // football-data sub-cache (seconds) — free tier is 10/min
const AF_TTL = 15; // api-football live sub-cache — Pro plan; ~15s matches how
                   // often api-football refreshes live fixtures (lighter WC query)
const LIVE_FD = ["LIVE", "IN_PLAY", "PAUSED"]; // football-data "live" statuses

// Route a request to a World Cup API handler, or return null if the path
// isn't one of ours (so the Worker entry can fall back to static assets).
export async function handleWorldCupApi(request, env, ctx) {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/api/wc": return handleWC(request, env, ctx);
    case "/api/news": return handleNews(request, env, ctx);
    case "/api/player": return handlePlayer(request, env, ctx);
    case "/api/events": return handleEvents(request, env, ctx);
    case "/api/wiki": return handleWiki(request, env, ctx);
    case "/api/records": return handleRecords(request, env, ctx);
    case "/api/bracket": return handleBracket(request, env, ctx);
    case "/api/squad": return handleSquad(request, env, ctx);
    case "/api/lineups": return handleLineups(request, env, ctx);
    default: return null;
  }
}

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
    venue: m.venue || "", // stadium name string (may be null on the free tier)
    home: { name: m.homeTeam?.shortName || m.homeTeam?.name || "TBD", crest: m.homeTeam?.crest || "", score: m.score?.fullTime?.home },
    away: { name: m.awayTeam?.shortName || m.awayTeam?.name || "TBD", crest: m.awayTeam?.crest || "", score: m.score?.fullTime?.away },
  }));

  // group lookup by team pair, so api-football live games can be tagged A–L
  const groupByPair = {};
  matches.forEach((m) => { groupByPair[pairKey(m.home.name, m.away.name)] = m.group; });

  const fdLive = matches.filter((m) => LIVE_FD.includes(m.status));

  // Only spend api-football requests when something is actually live.
  let live = null, source = "football-data";
  if (fdLive.length && env.APIFOOTBALL_KEY) {
    try {
      // Query ONLY the World Cup fixtures for today + yesterday (UTC). This is a
      // tiny payload (a handful of fixtures) — far lighter and faster than the
      // global live=all feed, and it stays well within the per-minute limit even
      // at a short poll interval. Yesterday is needed because a match in play
      // across UTC midnight is dated by its (earlier) kickoff day.
      const afHeaders = { "x-apisports-key": env.APIFOOTBALL_KEY };
      const dToday = new Date(now).toISOString().slice(0, 10);
      const dYest = new Date(now - DAY).toISOString().slice(0, 10);
      const base = `${AF}/fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}`;
      const [a, b] = await Promise.all([
        cachedJson(`${base}&date=${dToday}`, afHeaders, AF_TTL, `af-fix-${dToday}`).catch(() => null),
        cachedJson(`${base}&date=${dYest}`, afHeaders, AF_TTL, `af-fix-${dYest}`).catch(() => null),
      ]);
      const noErr = (x) => {
        const e = x && x.errors;
        return x && !(Array.isArray(e) ? e.length : e && Object.keys(e).length);
      };
      const fixtures = [].concat(noErr(a) ? a.response || [] : [], noErr(b) ? b.response || [] : []);
      const LIVE_AF = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "SUSP", "INT"];
      const mapped = fixtures
        .filter((f) => LIVE_AF.includes(f.fixture?.status?.short))
        .map((f) => {
          const hn = f.teams.home.name, an = f.teams.away.name;
          const short = f.fixture.status.short; // 1H,HT,2H,ET,BT,P...
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

// Player detail (bio + club career + World Cup stats) from api-football.
// PREFERRED: lookup by exact player id (?id=) — squad / line-up cards pass it,
// so we never mis-match an abbreviated name to the wrong player. FALLBACK: fuzzy
// name search (?name=&nat=) for the scorers / records tables. Cached 24h.
function aggWcStats(blocks) {
  if (!blocks || !blocks.length) return null;
  let apps = 0, goals = 0, assists = 0, minutes = 0, rSum = 0, rN = 0;
  for (const b of blocks) {
    const g = b.games || {};
    apps += g.appearences || 0; minutes += g.minutes || 0;
    goals += (b.goals && b.goals.total) || 0;
    assists += (b.goals && b.goals.assists) || 0;
    const rt = parseFloat(b.rating);
    if (Number.isFinite(rt)) { rSum += rt; rN++; }
  }
  return { apps, goals, assists, minutes, rating: rN ? +(rSum / rN).toFixed(2) : null };
}
async function fetchClubs(id, headers, nationality) {
  try {
    const tr = await fetch(`${AF}/players/teams?player=${id}`, { headers });
    if (!tr.ok) return [];
    const td = await tr.json();
    return (td.response || [])
      .filter((x) => x.team && norm(x.team.name) !== norm(nationality || ""))
      .map((x) => {
        const s = (x.seasons || []).filter((n) => typeof n === "number");
        return { name: x.team.name, logo: x.team.logo || "", from: s.length ? Math.min(...s) : null, to: s.length ? Math.max(...s) : null };
      })
      .filter((c) => c.from != null)
      .sort((a, b) => b.to - a.to || b.from - a.from);
  } catch (_) { return []; }
}
function buildPlayer(p, wcBlocks, clubs) {
  const fullName = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.name || "";
  const pos = (wcBlocks && wcBlocks[0] && wcBlocks[0].games && wcBlocks[0].games.position) || p.position || "";
  return {
    name: p.name, fullName, firstname: p.firstname, lastname: p.lastname,
    photo: p.photo || "", nationality: p.nationality || "",
    club: clubs[0] ? clubs[0].name : "", clubs, currentClub: clubs[0] ? { name: clubs[0].name, logo: clubs[0].logo } : null,
    stats: aggWcStats(wcBlocks),
    birthDate: (p.birth && p.birth.date) || "", birthPlace: (p.birth && p.birth.place) || "",
    age: p.age ?? null, height: p.height || "", weight: p.weight || "", position: pos, number: p.number ?? null,
  };
}
async function handlePlayer(request, env, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const name = (url.searchParams.get("name") || "").trim();
  const nat = (url.searchParams.get("nat") || "").trim();
  if (!/^\d+$/.test(id) && !name) return json({ error: "no_name" }, 400, 0);
  if (!env.APIFOOTBALL_KEY) return json({ error: "no_key" }, 200, 0);
  const headers = { "x-apisports-key": env.APIFOOTBALL_KEY };
  const cache = caches.default;

  // ── exact lookup by api-football player id (squad / line-up clicks) ──
  if (/^\d+$/.test(id)) {
    const ckey = new Request(`https://wc.cache/player5-id-${id}`);
    const hit = await cache.match(ckey);
    if (hit) return hit;
    try {
      const pr = await fetch(`${AF}/players?id=${id}&season=${WC_SEASON}`, { headers });
      if (!pr.ok) return json({ error: "upstream" }, 200, 0);
      const pd = await pr.json();
      const e = pd && pd.errors;
      if (Array.isArray(e) ? e.length : e && Object.keys(e).length) return json({ error: "rate_limited" }, 200, 0);
      const resp = (pd.response || [])[0];
      if (!resp || !resp.player) return json({ error: "not_found" }, 200, 0);
      const wc = (resp.statistics || []).filter((b) => b.league && b.league.id === WC_LEAGUE);
      const clubs = await fetchClubs(id, headers, resp.player.nationality);
      const res = json(buildPlayer(resp.player, wc, clubs), 200, 86400);
      ctx.waitUntil(cache.put(ckey, res.clone()));
      return res;
    } catch (_) {
      return json({ error: "failed" }, 200, 0);
    }
  }

  // ── fuzzy lookup by name (scorers / records / search) ──
  const last = name.split(/\s+/).pop().toLowerCase();
  const term = last.normalize("NFD").replace(/[̀-ͯ]/g, ""); // ASCII surname for search
  if (term.length < 3) return json({ error: "short" }, 200, 0);
  const ckey = new Request(`https://wc.cache/player5-${term}-${norm(nat)}`);
  const cached = await cache.match(ckey);
  if (cached) return cached;
  try {
    const r = await fetch(`${AF}/players/profiles?search=${encodeURIComponent(term)}`, { headers });
    if (!r.ok) return json({ error: "upstream" }, 200, 0);
    const data = await r.json();
    const errs = data && data.errors;
    if (Array.isArray(errs) ? errs.length : errs && Object.keys(errs).length)
      return json({ error: "rate_limited" }, 200, 0);
    const tokens = name.toLowerCase().split(/\s+/).map(norm).filter((t) => t.length >= 2);
    const surname = norm(last);
    const first = tokens[0] || "";
    let best = null, bestScore = 0;
    for (const rr of data.response || []) {
      const p = rr.player; if (!p) continue;
      const hay = norm(`${p.firstname || ""} ${p.lastname || ""} ${p.name || ""}`);
      if (!hay.includes(surname)) continue; // surname is mandatory
      const natMatch = nat && norm(p.nationality) === norm(nat);
      if (tokens.length > 1 && first && !hay.includes(first) && !natMatch) continue;
      let score = tokens.reduce((n, t) => n + (hay.includes(t) ? 2 : 0), 0);
      if (natMatch) score += 3;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return json({ error: "not_found" }, 200, 0);
    const clubs = await fetchClubs(best.id, headers, best.nationality);
    let wcBlocks = [];
    try {
      const sr = await fetch(`${AF}/players?id=${best.id}&season=${WC_SEASON}&league=${WC_LEAGUE}`, { headers });
      if (sr.ok) wcBlocks = (((await sr.json()).response || [])[0] || {}).statistics || [];
    } catch (_) { /* stats optional */ }
    const res = json(buildPlayer(best, wcBlocks, clubs), 200, 86400);
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
  const kindParam = u.searchParams.get("kind");
  const kind = (kindParam === "team" || kindParam === "stadium") ? kindParam : "player";
  if (q.length < 2) return json({ results: [] }, 200, 0);

  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/wiki-${kind}-${q.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  const suffix = kind === "team" ? " national football team" : (kind === "stadium" ? "" : " footballer");
  const keep = kind === "team" ? /national.*football team|national team/i
             : (kind === "stadium" ? /stadium|arena|field|park|place|estadio|sports venue/i : /footballer/i);
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
// Both teams' line-ups for one fixture (lazy — only when a live card is
// clicked). api-football publishes line-ups ~20-40 min before kickoff and keeps
// them through the match. Cached ~60s so repeated opens during a match don't
// burn requests. Returns 200 with {error}/empty teams on failure so the page
// can fall back to full squads.
async function handleLineups(request, env, ctx) {
  const url = new URL(request.url);
  const fid = url.searchParams.get("fixture") || "";
  if (!/^\d+$/.test(fid)) return json({ error: "bad_fixture" }, 400, 0);
  if (!env.APIFOOTBALL_KEY) return json({ error: "no_key" }, 200, 0);

  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/lineups-${fid}`);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  try {
    const r = await fetch(`${AF}/fixtures/lineups?fixture=${fid}`, {
      headers: { "x-apisports-key": env.APIFOOTBALL_KEY },
    });
    if (!r.ok) return json({ error: "upstream" }, 200, 0);
    const d = await r.json();
    const e = d && d.errors;
    if (Array.isArray(e) ? e.length : e && Object.keys(e).length)
      return json({ error: "rate_limited" }, 200, 0);
    const mapPlayer = (x) => ({
      id: (x.player && x.player.id) || null,
      name: (x.player && x.player.name) || "",
      number: (x.player && x.player.number) ?? null,
      pos: (x.player && x.player.pos) || "",
    });
    const teams = (d.response || []).map((tm) => ({
      name: (tm.team && tm.team.name) || "",
      logo: (tm.team && tm.team.logo) || "",
      formation: tm.formation || "",
      coach: (tm.coach && tm.coach.name) || "",
      startXI: (tm.startXI || []).map(mapPlayer).filter((p) => p.name),
      subs: (tm.substitutes || []).map(mapPlayer).filter((p) => p.name),
    }));
    if (!teams.some((tm) => tm.startXI.length))
      return json({ fixture: Number(fid), teams: [] }, 200, 0); // not posted yet
    const res = json({ fixture: Number(fid), teams }, 200, 60);
    ctx.waitUntil(cache.put(ckey, res.clone()));
    return res;
  } catch (_) {
    return json({ error: "failed" }, 200, 0);
  }
}

// ───────── Squads tab: a nation's full roster by country name ─────────
// api-football first (player photos + ages); if it's unavailable / out of
// quota, fall back to Wikipedia (free, unlimited; gives club but no photos).
const SEARCH_ALIAS = {
  unitedstates: "usa", turkiye: "turkey", czechia: "czech republic",
  cotedivoire: "ivory coast", drcongo: "congo dr", capeverde: "cape verde",
  bosniaherzegovina: "bosnia and herzegovina", southkorea: "south korea",
};
async function resolveNationalTeamId(name, headers) {
  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/teamid-${norm(name)}`);
  const hit = await cache.match(ckey);
  if (hit) return (await hit.json()).id;
  const term = (SEARCH_ALIAS[norm(name)] || name).normalize("NFD").replace(/[̀-ͯ]/g, "");
  const r = await fetch(`${AF}/teams?search=${encodeURIComponent(term)}`, { headers });
  if (!r.ok) return null;
  const d = await r.json();
  const e = d && d.errors;
  if (Array.isArray(e) ? e.length : e && Object.keys(e).length) throw new Error("rate_limited");
  const list = d.response || [];
  const best =
    list.find((x) => x.team && x.team.national && norm(x.team.name) === norm(name)) ||
    list.find((x) => x.team && x.team.national) || list[0];
  const id = best && best.team ? best.team.id : null;
  if (id) {
    await cache.put(ckey, new Response(JSON.stringify({ id }), {
      headers: { "content-type": "application/json", "cache-control": "max-age=2592000" },
    }));
  }
  return id;
}
async function apiFootballSquad(name, env) {
  const headers = { "x-apisports-key": env.APIFOOTBALL_KEY };
  const teamId = await resolveNationalTeamId(name, headers);
  if (!teamId) return null;
  const r = await fetch(`${AF}/players/squads?team=${teamId}`, { headers });
  if (!r.ok) return null;
  const d = await r.json();
  const e = d && d.errors;
  if (Array.isArray(e) ? e.length : e && Object.keys(e).length) throw new Error("rate_limited");
  const squad = (d.response || [])[0];
  let players = ((squad && squad.players) || []).map((p) => ({
    id: p.id || null, name: p.name || "", number: p.number ?? null,
    position: p.position || "", age: p.age ?? null, club: "", photo: p.photo || "",
  })).filter((p) => p.name);
  if (!players.length) return null;

  // api-football gives abbreviated names ("S. Repi"); upgrade to full names from
  // the Wikipedia squad, matched by shirt number AND surname (so we never attach
  // the wrong full name to a face). Unmatched players keep the abbreviated name.
  try {
    const all = await getAllSquads();
    const wt = all[norm(name)];
    if (wt && wt.players && wt.players.length) {
      const byNum = {};
      wt.players.forEach((w) => { if (w.number != null) byNum[w.number] = w; });
      const lastOf = (s) => norm(String(s).split(/\s+/).pop());
      players = players.map((p) => {
        const w = p.number != null ? byNum[p.number] : null;
        if (w && lastOf(w.name) === lastOf(p.name)) return { ...p, name: w.name, club: w.club || p.club };
        return p;
      });
    }
  } catch (_) { /* full-name upgrade is best-effort */ }

  return { team: (squad.team && squad.team.name) || name, logo: (squad.team && squad.team.logo) || "", players };
}
// Wikipedia squads: parse the "2026 FIFA World Cup squads" article once for all
// 48 teams (cached 6h), then serve per team. Position codes (GK/DF/MF/FW) map to
// the same words api-football uses so the page groups both sources identically.
const WPOS = { GK: "Goalkeeper", DF: "Defender", MF: "Midfielder", FW: "Attacker" };
function parseSquadTable(table) {
  const rows = wRows(table);
  if (rows.length < 2) return [];
  const header = wCells(rows[0]).map((s) => s.toLowerCase());
  const iPlayer = header.findIndex((h) => /player/.test(h));
  const iPos = header.findIndex((h) => /pos/.test(h));
  const iDob = header.findIndex((h) => /birth|age/.test(h));
  const iClub = header.findIndex((h) => /club/.test(h));
  const iNo = header.findIndex((h) => /^no/.test(h));
  if (iPlayer < 0 || iPos < 0) return [];
  const out = [];
  for (const r of rows.slice(1)) {
    const c = wCells(r);
    if (c.length <= iPlayer) continue;
    const name = c[iPlayer].replace(/\s*\(\s*(?:c|captain)\s*\)\s*$/i, "").trim();
    if (!name) continue;
    const pm = (c[iPos] || "").toUpperCase().match(/GK|DF|MF|FW/);
    const num = iNo >= 0 ? parseInt(c[iNo], 10) : NaN;
    const am = iDob >= 0 ? (c[iDob] || "").match(/aged?\s*(\d{1,2})/i) : null;
    out.push({
      name, number: Number.isFinite(num) ? num : null,
      position: pm ? WPOS[pm[0]] : "", age: am ? +am[1] : null,
      club: iClub >= 0 ? (c[iClub] || "") : "", photo: "",
    });
  }
  return out;
}
function parseSquads(html) {
  const teams = {};
  const re = /<h[234][^>]*>([\s\S]*?)<\/h[234]>|<table[^>]*wikitable[^>]*>[\s\S]*?<\/table>/g;
  let m, cur = null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const nm = wtidy(m[1]).replace(/\s*\[\s*edit\s*\]\s*/gi, "").trim();
      if (nm) cur = nm;
    } else if (cur) {
      const players = parseSquadTable(m[0]);
      const k = norm(cur);
      if (players.length && !teams[k]) teams[k] = { name: cur, players };
    }
  }
  return teams;
}
async function getAllSquads() {
  const cache = caches.default;
  const ckey = new Request("https://wc.cache/squads-wiki-v2");
  const hit = await cache.match(ckey);
  if (hit) return hit.json();
  const html = await wikiPageHtml("2026_FIFA_World_Cup_squads");
  const teams = parseSquads(html);
  if (!Object.keys(teams).length) return {};
  await cache.put(ckey, new Response(JSON.stringify(teams), {
    headers: { "content-type": "application/json", "cache-control": "max-age=21600" },
  }));
  return teams;
}
async function handleSquad(request, env, ctx) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("team") || "").trim();
  if (!name) return json({ error: "no_team" }, 400, 0);

  const cache = caches.default;
  const ckey = new Request(`https://wc.cache/squad-v2-${norm(name)}`);
  const hit = await cache.match(ckey);
  if (hit) return hit;

  // 1) api-football first (photos + ages) — when a key is set & in quota
  if (env.APIFOOTBALL_KEY) {
    try {
      const af = await apiFootballSquad(name, env);
      if (af) {
        const res = json({ source: "api-football", ...af }, 200, 86400);
        ctx.waitUntil(cache.put(ckey, res.clone()));
        return res;
      }
    } catch (_) { /* quota/error — fall through to Wikipedia */ }
  }

  // 2) Wikipedia fallback (free, unlimited). NOT stored under ckey, so the next
  //    request re-tries api-football first (e.g. once quota resets).
  try {
    const all = await getAllSquads();
    const team = all[norm(name)];
    if (team && team.players.length)
      return json({ source: "wikipedia", team: team.name, players: team.players }, 200, 1800);
  } catch (_) { /* ignore */ }

  return json({ error: "not_found" }, 200, 0);
}

// The 48 qualified nations (kept in sync with the frontend TEAMS list). Used to
// pre-warm api-football squads so every team consistently serves with photos.
const WC_TEAM_NAMES = [
  "United States", "Canada", "Mexico", "Austria", "Belgium", "Bosnia & Herzegovina",
  "Croatia", "Czechia", "England", "France", "Germany", "Netherlands", "Norway",
  "Portugal", "Scotland", "Spain", "Sweden", "Switzerland", "Türkiye", "Argentina",
  "Brazil", "Colombia", "Ecuador", "Paraguay", "Uruguay", "Algeria", "Cape Verde",
  "DR Congo", "Côte d'Ivoire", "Egypt", "Ghana", "Morocco", "Senegal", "South Africa",
  "Tunisia", "Australia", "Iran", "Iraq", "Japan", "Jordan", "South Korea", "Qatar",
  "Saudi Arabia", "Uzbekistan", "Curaçao", "Haiti", "Panama", "New Zealand",
];
// Pre-fetch every nation's api-football squad and cache it (24h) so the Squads
// tab always serves real player photos instead of the photo-less Wikipedia
// fallback. Run on a cron. Sequential with a small gap to stay within the
// per-minute limit; teams that error (rate-limited) are simply retried next run.
export async function warmSquads(env) {
  if (!env.APIFOOTBALL_KEY) return;
  const cache = caches.default;
  let ok = 0;
  for (const name of WC_TEAM_NAMES) {
    try {
      const af = await apiFootballSquad(name, env);
      if (af) {
        await cache.put(
          new Request(`https://wc.cache/squad-v2-${norm(name)}`),
          json({ source: "api-football", ...af }, 200, 86400)
        );
        ok++;
      }
    } catch (_) { /* rate-limited / transient — caught next run */ }
    await new Promise((r) => setTimeout(r, 250)); // ~4 req/s, well under 300/min
  }
  return ok;
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
const wRows = (t) => t.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
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

// ───────── Knockout bracket (parsed from Wikipedia, cached) ─────────
// The "knockout stage" article holds the whole bracket in a {{#invoke:RoundN}}
// template: per match a "Date – Place | Team1 | Score1 | Team2 | Score2" tuple,
// where a team is either a flag code (clinched) or a slot label ("Winner Group
// A", "3rd Group A/B/C/D/F", "Winner Match 73"). We return it round by round and
// let the page render the tree. Cached 15 min so it tracks Wikipedia as teams
// and scores fill in.
async function handleBracket(request, env, ctx) {
  const cache = caches.default;
  const ckey = new Request("https://wc.cache/bracket-v1");
  const hit = await cache.match(ckey);
  if (hit) return hit;
  try {
    const r = await fetch(
      "https://en.wikipedia.org/w/api.php?action=parse&page=2026_FIFA_World_Cup_knockout_stage&prop=wikitext&format=json&formatversion=2",
      { headers: { "user-agent": "samueltung.com/1.0 (World Cup bracket)" } }
    );
    if (!r.ok) throw new Error("wiki " + r.status);
    const d = await r.json();
    const rounds = parseBracket((d.parse && d.parse.wikitext) || "");
    if (!rounds.length) throw new Error("no bracket");
    const res = json({ source: "wikipedia", updated: new Date().toISOString(), rounds }, 200, 900);
    ctx.waitUntil(cache.put(ckey, res.clone()));
    return res;
  } catch (e) {
    return json({ error: "bracket_failed", message: String(e) }, 200, 0);
  }
}
function parseBracket(wt) {
  const i = wt.indexOf("{{#invoke:RoundN");
  if (i < 0) return [];
  let depth = 0, j = i;
  while (j < wt.length) {
    if (wt.substr(j, 2) === "{{") { depth++; j += 2; continue; }
    if (wt.substr(j, 2) === "}}") { depth--; j += 2; } else j++;
    if (depth === 0) break;
  }
  const inner = wt.slice(i + 2, j - 2);
  const splitTop = (s) => {
    const toks = []; let buf = "", b = 0, sq = 0, k = 0;
    while (k < s.length) {
      const two = s.substr(k, 2);
      if (two === "{{") { b++; buf += two; k += 2; continue; }
      if (two === "}}") { b--; buf += two; k += 2; continue; }
      if (two === "[[") { sq++; buf += two; k += 2; continue; }
      if (two === "]]") { sq--; buf += two; k += 2; continue; }
      if (s[k] === "|" && b === 0 && sq === 0) { toks.push(buf); buf = ""; k++; continue; }
      buf += s[k]; k++;
    }
    toks.push(buf); return toks;
  };
  const team = (mk) => {
    mk = mk.replace(/<!--[\s\S]*?-->/g, "").trim();
    const m = mk.match(/#invoke:flag\|fb[^|}]*\|([A-Za-z]{3})/);
    if (m) return { code: m[1].toUpperCase() };
    const txt = mk.replace(/\[\[[^\]|]*\|?([^\]]*)\]\]/g, "$1").replace(/'''/g, "").replace(/^\|+|\|+$/g, "").trim();
    return { slot: txt };
  };
  const dateplace = (dp) => {
    dp = dp.replace(/<!--[\s\S]*?-->/g, "").replace(/\[\[[^\]|]*\|?([^\]]*)\]\]/g, "$1").trim();
    const m = dp.match(/([A-Za-z]+ \d+)\s*[–-]\s*(.*)/);
    return m ? { date: m[1], place: m[2].trim() } : { date: dp, place: "" };
  };
  const score = (x) => x.replace(/<!--[\s\S]*?-->/g, "").replace(/'''/g, "").trim();
  const RMAP = { "Round of 32": "R32", "Round of 16": "R16", "Quarterfinals": "QF", "Quarterfinal": "QF", "Semifinals": "SF", "Semifinal": "SF", "Final": "F", "Match for third place": "3P" };
  const parts = inner.split(/<!--\s*(Round of 32|Round of 16|Quarterfinals?|Semifinals?|Final|Match for third place)\s*-->/i);
  const rounds = [];
  for (let k = 1; k < parts.length; k += 2) {
    const key = RMAP[parts[k]] || parts[k];
    const fields = splitTop(parts[k + 1]).slice(1).map((x) => x.trim());
    const n = Math.floor(fields.length / 5);
    const matches = [];
    for (let a = 0; a < n; a++) {
      const f = fields.slice(a * 5, a * 5 + 5);
      const dp = dateplace(f[0]);
      matches.push({ date: dp.date, place: dp.place, t1: team(f[1]), s1: score(f[2]), t2: team(f[3]), s2: score(f[4]) });
    }
    rounds.push({ key, matches });
  }
  return rounds;
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
// Keep in sync with the frontend ALIAS so Wikipedia squad headings ("Czech
// Republic", "Ivory Coast") and the names the page sends ("Czechia", "Côte
// d'Ivoire") normalize to the same canonical key.
const ALIAS = {
  korearepublic: "southkorea", republicofkorea: "southkorea", koreasouth: "southkorea",
  iriran: "iran", caboverde: "capeverde",
  congodr: "drcongo", congodrc: "drcongo", democraticrepublicofthecongo: "drcongo",
  bosniaandherzegovina: "bosniaherzegovina", turkey: "turkiye",
  czechrepublic: "czechia", ivorycoast: "cotedivoire",
  usa: "unitedstates", unitedstatesofamerica: "unitedstates", us: "unitedstates",
};
function norm(s) {
  const k = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  return ALIAS[k] || k;
}
function pairKey(a, b) { return norm(a) + "|" + norm(b); }
