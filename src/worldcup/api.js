// World Cup 2026 feature — API handlers.
// All /api/* endpoints used by public/worldcup/index.html live here; src/index.js
// is just the Worker entry that routes to handleWorldCupApi() below.
//
//   GET /api/wc       ->  { updated, source, groups[], matches[], live[], scorers[], koSched[] }
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
// opts.isBad(data): api-football returns HTTP 200 with an `errors` payload when
// throttled — those must never be cached (they'd poison every poll for `ttl`).
// opts.lastGoodTtl: also keep the last good payload under a longer TTL and
// serve it when a fetch fails or comes back bad, so one throttled minute
// doesn't drop the whole feature (live kit colors, match minute).
async function cachedJson(url, headers, ttl, keyStr, opts) {
  const cache = caches.default;
  const key = new Request("https://wc.cache/" + encodeURIComponent(keyStr));
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const lgKey = opts && opts.lastGoodTtl
    ? new Request("https://wc.cache/" + encodeURIComponent(keyStr) + "-lastgood")
    : null;
  const lastGood = async () => {
    const lg = lgKey && (await cache.match(lgKey));
    return lg ? lg.json() : null;
  };
  let data;
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    data = await r.json();
  } catch (e) {
    const lg = await lastGood();
    if (lg) return lg;
    throw e;
  }
  if (opts && opts.isBad && opts.isBad(data)) {
    const lg = await lastGood();
    return lg || data; // never cache a bad payload
  }
  const body = JSON.stringify(data);
  await cache.put(
    key,
    new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    })
  );
  if (lgKey) {
    await cache.put(lgKey, new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `max-age=${opts.lastGoodTtl}` },
    }));
  }
  return data;
}

// The kit colors a fixture's teams are wearing today, as { "Team Name": "#hex" }.
// Colors don't change during a match, so resolve ONCE per fixture and cache for
// hours; never cache an empty result so a failed attempt just retries later.
// Source order: Sportradar gismo (scouted per-match jerseys, `real:true` flag —
// verified correct: Canada black / Morocco white R16 while everyone else said
// red/red) → Sofascore (editor-set per-match; 403s datacenter AND residential
// IPs as of Jul 2026 — kept as best-effort) → api-football lineups (usually
// static brand colors, NOT the match kit — sanitized hard, see afKitColors)
// → nothing, and the page keeps the team's static brand color.
// Read already-resolved kit colors from cache only (no upstream call), so the
// live path never blocks on upstreams. Returns the {name:#hex} map or null.
// Key is versioned (kit4) — bump it when the pipeline changes so stale wrong
// colors from the old logic don't outlive a deploy.
const KIT_KEY = "kit4";
async function readKitColors(fid) {
  const hit = await caches.default.match(new Request(`https://wc.cache/${KIT_KEY}-${fid}`));
  return hit ? hit.json() : null;
}

// RGB distance between two hex colors (0–441), tolerant of missing '#'.
function hexDist(a, b) {
  const p = (h) => {
    let n = String(h || "").replace("#", "");
    if (n.length === 3) n = n.replace(/./g, (c) => c + c);
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
  };
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  if ([r1, g1, b1, r2, g2, b2].some(isNaN)) return 441;
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
}

// Perceived luminance (0–255) and chroma (max−min channel spread) of a hex
// color — same formulas as the frontend's hexLum/chroma so "whitish" means the
// same thing on both sides: light AND unsaturated.
function hexLum(hex) {
  const n = String(hex || "").replace("#", "");
  if (n.length < 6) return 128;
  return 0.299 * parseInt(n.slice(0, 2), 16) + 0.587 * parseInt(n.slice(2, 4), 16) + 0.114 * parseInt(n.slice(4, 6), 16);
}
function hexChroma(hex) {
  const n = String(hex || "").replace("#", "");
  if (n.length < 6) return 0;
  const v = [n.slice(0, 2), n.slice(2, 4), n.slice(4, 6)].map((x) => parseInt(x, 16));
  return Math.max(...v) - Math.min(...v);
}
const whitish = (c) => hexLum(c) >= 205 && hexChroma(c) < 36;

// Sportradar gismo — the open feed behind their embeddable Live Match Tracker
// widgets (lsc.fn.sportradar.com works keyless; ls.fn.sportradar.com 403s).
// match_info carries the jersey each side actually wears, scouted per match,
// with a `real:true` flag once confirmed. This is the only source that knew
// Canada wore black vs Morocco in white (2026 R16) — make it the primary.
const SR = "https://lsc.fn.sportradar.com/common/en/Etc:UTC/gismo";
const SR_HDRS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "application/json",
};
const srJerseys = (x) => ((((x || {}).doc || [])[0] || {}).data || {}).jerseys || {};
// Only accept a jersey Sportradar marks real (scout-confirmed for THIS match);
// unflagged ones are the same brand-default guesswork api-football serves.
const srBase = (side) => {
  const p = side && side.player;
  return p && p.real && p.base ? (String(p.base).startsWith("#") ? p.base : "#" + p.base) : null;
};
async function srKitColors(hn, an, dates) {
  for (const d of dates) {
    let list;
    try {
      // All soccer for the day (~600KB) — cached, and only parsed until the
      // per-fixture kit cache sticks, so the cost is a few warm-up polls.
      list = await cachedJson(`${SR}/sport_matches/1/${d}/0`, SR_HDRS, 900, `sr-ev-${d}`);
    } catch (_) { continue; }
    const matches = [];
    const sport = ((((list.doc || [])[0] || {}).data || {}).sport) || {};
    for (const rc of sport.realcategories || []) {
      for (const t of rc.tournaments || []) {
        const tn = String(t.name || "");
        // skip "World Cup SRL" — simulated-reality clones of the real fixtures
        if (!/world cup/i.test(tn) || /SRL/i.test(tn)) continue;
        matches.push(...(t.matches || []));
      }
    }
    const teams = (m) => m.teams || {};
    let flip = false;
    let m = matches.find((x) => norm((teams(x).home || {}).name) === norm(hn) && norm((teams(x).away || {}).name) === norm(an));
    if (!m) { m = matches.find((x) => norm((teams(x).home || {}).name) === norm(an) && norm((teams(x).away || {}).name) === norm(hn)); flip = !!m; }
    if (!m) continue;
    let info;
    try {
      // isBad: don't cache match_info until at least one jersey is scout-
      // confirmed, so pre-kickoff placeholder data just retries next poll.
      info = await cachedJson(`${SR}/match_info/${m._id}`, SR_HDRS, 3600, `sr-info-${m._id}`, {
        isBad: (x) => { const j = srJerseys(x); return !srBase(j.home) && !srBase(j.away); },
      });
    } catch (_) { return null; }
    const j = srJerseys(info);
    let hc = srBase(j.home), ac = srBase(j.away);
    if (flip) { const t = hc; hc = ac; ac = t; }
    if (!hc && !ac) return null;
    const out = {};
    if (hc) out[hn] = hc;
    if (ac) out[an] = ac;
    return out;
  }
  return null;
}

// Sofascore: find the event by date + team names, then read the lineups'
// playerColor.primary — the jersey each side actually wears, set per match.
// Blocked (403) from datacenter IPs and, as of Jul 2026, residential ones too —
// strictly best-effort, kept in case the block is lifted.
const SOFA = "https://api.sofascore.com/api/v1";
const SOFA_HDRS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "application/json",
};
async function sofaKitColors(hn, an, dates) {
  for (const d of dates) {
    let list;
    try {
      list = await cachedJson(`${SOFA}/sport/football/scheduled-events/${d}`, SOFA_HDRS, 900, `sofa-ev-${d}`);
    } catch (_) { continue; }
    const evs = (list.events || []).filter((e) => e.homeTeam && e.awayTeam);
    let flip = false;
    let ev = evs.find((e) => norm(e.homeTeam.name) === norm(hn) && norm(e.awayTeam.name) === norm(an));
    if (!ev) { ev = evs.find((e) => norm(e.homeTeam.name) === norm(an) && norm(e.awayTeam.name) === norm(hn)); flip = !!ev; }
    if (!ev) continue;
    try {
      const r = await fetch(`${SOFA}/event/${ev.id}/lineups`, { headers: SOFA_HDRS });
      if (!r.ok) return null;
      const lu = await r.json();
      const hex = (c) => (c && c.primary ? (String(c.primary).startsWith("#") ? c.primary : "#" + c.primary) : null);
      let hc = hex(lu && lu.home && lu.home.playerColor), ac = hex(lu && lu.away && lu.away.playerColor);
      if (flip) { const t = hc; hc = ac; ac = t; }
      if (!hc && !ac) return null;
      const out = {};
      if (hc) out[hn] = hc;
      if (ac) out[an] = ac;
      return out;
    } catch (_) { return null; }
  }
  return null;
}

// api-football lineups fallback. team.colors.player.primary is sometimes the
// WRONG field: the real shirt can sit in player.number instead (verified live:
// Portugal 2026 R32 — primary said dark red, the team wore the light teal that
// appeared as number + GK color). Detect that scramble by its impossible
// signature — outfield "number" ≈ own GK shirt — and prefer number then.
async function afKitColors(fid, afHeaders) {
  try {
    const r = await fetch(`${AF}/fixtures/lineups?fixture=${fid}`, { headers: afHeaders });
    if (!r.ok) return null;
    const d = await r.json();
    const resp = (d && d.response) || [];
    if (!resp.length) return null; // rate-limited or not posted yet
    const out = {};
    resp.forEach((t) => {
      const nm = t.team && t.team.name;
      const c = t.team && t.team.colors, p = c && c.player, g = c && c.goalkeeper;
      if (!nm || !p || !p.primary) return;
      let shirt = p.primary;
      if (p.number && g && g.primary &&
          hexDist(p.number, g.primary) < 70 && hexDist(p.number, p.primary) > 120) shirt = p.number;
      shirt = String(shirt).startsWith("#") ? shirt : "#" + shirt;
      // api-football's whites are usually bogus placeholders (Bosnia "white"
      // while wearing blue) — drop them; a real white kit reaches the page via
      // Sportradar, which we trust with whites.
      if (whitish(shirt)) return;
      out[nm] = shirt;
    });
    // Two "kits" the referee couldn't tell apart = static brand colors for a
    // clash pairing (Canada red vs Morocco red), not what anyone is wearing.
    const vals = Object.values(out);
    if (vals.length === 2 && hexDist(vals[0], vals[1]) < 80) return null;
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

async function fixtureColors(fid, afHeaders, hn, an, dates) {
  const cache = caches.default;
  const key = new Request(`https://wc.cache/${KIT_KEY}-${fid}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  let out = null;
  if (hn && an) out = await srKitColors(hn, an, dates || []);
  if (!out && hn && an) out = await sofaKitColors(hn, an, dates || []);
  if (!out) out = await afKitColors(fid, afHeaders);
  if (!out) return {};
  await cache.put(key, new Response(JSON.stringify(out), {
    headers: { "content-type": "application/json", "cache-control": "max-age=10800" },
  }));
  return out;
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
  // wide window (covers the whole knockout stage) for schedule kickoff times
  const schedTo = new Date(now + 32 * DAY).toISOString().slice(0, 10);

  let standings, matchesRaw, scorersRaw, schedRaw;
  try {
    [standings, matchesRaw, scorersRaw, schedRaw] = await Promise.all([
      cachedJson(`${FD}/standings`, fdHeaders, FD_TTL, "fd-standings"),
      cachedJson(`${FD}/matches?dateFrom=${from}&dateTo=${to}`, fdHeaders, FD_TTL, `fd-matches-${from}`),
      cachedJson(`${FD}/scorers?limit=60`, fdHeaders, 300, "fd-scorers-60").catch(() => null),
      // Wide fixture window (long-cached) purely to feed the schedule kickoff
      // times: the live matches query above is only ±1 day, so on its own it
      // can't time the whole knockout bracket. Best-effort — null if it fails.
      cachedJson(`${FD}/matches?dateFrom=${from}&dateTo=${schedTo}`, fdHeaders, 600, `fd-matches-wide-${from}`).catch(() => null),
    ]);
  } catch (err) {
    return json({ error: "upstream", message: String(err) }, 502, 0);
  }

  // Compact knockout schedule (kickoff time + status), so the calendar can show
  // R32/R16/QF/SF/Final times that fall outside the live ±1-day window.
  const koSched = (schedRaw?.matches || [])
    .filter((m) => m.stage && m.stage !== "GROUP_STAGE")
    .map((m) => ({
      h: m.homeTeam?.shortName || m.homeTeam?.name || "TBD",
      a: m.awayTeam?.shortName || m.awayTeam?.name || "TBD",
      utc: m.utcDate,
      st: m.status,
    }));

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
  // football-data's free feed can lag well past kickoff (still TIMED at 19:13
  // for a 19:00 game), which would keep api-football gated off exactly when a
  // match goes live. So also open the gate whenever a not-finished match's
  // scheduled kickoff has passed within the last ~3.5h (covers ET + pens).
  const maybeLive = matches.some((m) => {
    if (m.status === "FINISHED") return false;
    const ko = Date.parse(m.utcDate);
    return ko <= now && now - ko < 3.5 * 3600000;
  });

  // Only spend api-football requests when something is (or should be) live.
  let live = null, source = "football-data";
  // Diagnostics for the api-football branch, returned only with ?debug=1 —
  // shows why live fell back to football-data (throttle, gate, mapping).
  const dbg = { fdLive: fdLive.length, maybeLive, hasKey: !!env.APIFOOTBALL_KEY };
  if ((fdLive.length || maybeLive) && env.APIFOOTBALL_KEY) {
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
      const hasErrs = (x) => {
        const e = x && x.errors;
        return !!(Array.isArray(e) ? e.length : e && Object.keys(e).length);
      };
      // Never cache api-football's 200-with-errors throttle payloads, and bridge
      // throttled windows with the last good snapshot (a ~minutes-old fixture
      // list still carries the right kit colors and a near-right minute — far
      // better than dropping to football-data, which has neither).
      const afOpts = { isBad: hasErrs, lastGoodTtl: 600 };
      // The latest kickoff slot is ~04:00 UTC; with ET + pens nothing from
      // yesterday can still be live after ~08:00 UTC — skip that query (and its
      // api-football quota) for most of the day.
      const needYest = new Date(now).getUTCHours() < 8;
      const [a, b] = await Promise.all([
        cachedJson(`${base}&date=${dToday}`, afHeaders, AF_TTL, `af-fix-${dToday}`, afOpts).catch((e) => { dbg.errT = String(e); return null; }),
        needYest
          ? cachedJson(`${base}&date=${dYest}`, afHeaders, AF_TTL, `af-fix-${dYest}`, afOpts).catch((e) => { dbg.errY = String(e); return null; })
          : null,
      ]);
      dbg.aErrs = a && a.errors; dbg.bErrs = b && b.errors;
      dbg.aCount = a && a.response && a.response.length; dbg.bCount = b && b.response && b.response.length;
      const noErr = (x) => x && !hasErrs(x);
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
      if (mapped.length) {
        // Tint each side with the kit the team is ACTUALLY wearing today, not
        // its static brand color (e.g. Japan in white, not their usual blue).
        // api-football lineups carry team.colors.player.primary; cache per
        // fixture (colors are fixed for the match) so this is ~1 call per live
        // game, not per poll. Best-effort — the page falls back to static kits.
        await Promise.all(mapped.map(async (mm) => {
          if (!mm.fixtureId) return;
          const cols = await readKitColors(mm.fixtureId);
          if (cols) {
            if (cols[mm.home.name]) mm.homeColor = cols[mm.home.name];
            if (cols[mm.away.name]) mm.awayColor = cols[mm.away.name];
          } else if (ctx) {
            // not resolved yet — warm the cache off the hot path (one success
            // sticks for the whole match, then every poll reads it from cache)
            ctx.waitUntil(fixtureColors(mm.fixtureId, afHeaders, mm.home.name, mm.away.name, [dToday, dYest]));
          }
        }));
        live = mapped; source = "api-football";
      }
      dbg.mapped = mapped.length; dbg.statuses = fixtures.map((f) => f.fixture && f.fixture.status && f.fixture.status.short);
    } catch (e) {
      dbg.thrown = String(e && e.stack || e);
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

  const wantDbg = new URL(request.url).searchParams.has("debug");
  return json({ updated: new Date().toISOString(), source, groups, matches, live, scorers, koSched, ...(wantDbg ? { dbg } : {}) });
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
function buildPlayer(p, stats, clubs, position) {
  const fullName = [p.firstname, p.lastname].filter(Boolean).join(" ") || p.name || "";
  return {
    name: p.name, fullName, firstname: p.firstname, lastname: p.lastname,
    photo: p.photo || "", nationality: p.nationality || "",
    club: clubs[0] ? clubs[0].name : "", clubs, currentClub: clubs[0] ? { name: clubs[0].name, logo: clubs[0].logo } : null,
    stats,
    birthDate: (p.birth && p.birth.date) || "", birthPlace: (p.birth && p.birth.place) || "",
    age: p.age ?? null, height: p.height || "", weight: p.weight || "", position: position || p.position || "", number: p.number ?? null,
  };
}
// All-time World Cup career: api-football keys stats by season, so we fetch the
// World Cup (league 1) for each tournament year and aggregate. Coverage is ~2006
// onward; years with no data simply contribute nothing. Runs the years in
// parallel. Returns the (newest) player object, aggregated stats, and position.
const WC_YEARS = [2026, 2022, 2018, 2014, 2010, 2006];
// Fetch one player id's WC seasons, keyed by season (so two ids can be merged
// without double-counting). `complete` is false if any year fetch was throttled/
// failed (an under-count we must not cache).
async function wcBlocksFor(id, headers) {
  const results = await Promise.all(WC_YEARS.map((y) =>
    fetch(`${AF}/players?id=${id}&season=${y}&league=${WC_LEAGUE}`, { headers })
      .then((r) => (r.ok ? r.json() : { _fail: true })).catch(() => ({ _fail: true }))
  ));
  let player = null, complete = true;
  const bySeason = {};
  for (const d of results) {
    if (!d || d._fail) { complete = false; continue; }
    const e = d.errors;
    if (Array.isArray(e) ? e.length : e && Object.keys(e).length) { complete = false; continue; }
    const resp = (d.response || [])[0];
    if (!resp) continue;
    if (!player && resp.player) player = resp.player;
    for (const b of (resp.statistics || [])) {
      if (b.league && b.league.id === WC_LEAGUE && b.league.season != null) bySeason[b.league.season] = b;
    }
  }
  return { player, bySeason, complete };
}
// Resolve a player's canonical api-football id from surname + nationality.
async function resolveProfileId(surname, nat, headers) {
  const term = String(surname || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (term.length < 3) return null;
  try {
    const r = await fetch(`${AF}/players/profiles?search=${encodeURIComponent(term)}`, { headers });
    if (!r.ok) return null;
    const d = await r.json();
    const e = d.errors;
    if (Array.isArray(e) ? e.length : e && Object.keys(e).length) return null;
    let best = null, bestScore = -1;
    for (const rr of d.response || []) {
      const p = rr.player; if (!p) continue;
      const hay = norm(`${p.firstname || ""} ${p.lastname || ""} ${p.name || ""}`);
      if (!hay.includes(norm(surname))) continue;
      let score = 1; if (nat && norm(p.nationality) === norm(nat)) score += 3;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best ? best.id : null;
  } catch (_) { return null; }
}
// All-time WC career for a player id. Because api-football ids can change across
// tournaments, we also resolve the canonical profile id (by name + nationality)
// and MERGE its seasons — but only fetch the extra id when it differs from the
// one we were given (so stable-id players cost nothing extra). `skipAlt` skips
// that step (used by the name path, whose id is already the canonical one).
async function wcCareer(id, headers, skipAlt) {
  const a = await wcBlocksFor(id, headers);
  const bySeason = { ...a.bySeason };
  let player = a.player, complete = a.complete;
  if (!skipAlt) {
    // search by the player's common/display name (last token) — matches how the
    // name path resolves it (e.g. "Neymar", not the long legal lastname)
    const dn = (player && player.name) || "";
    const surname = dn.split(/\s+/).pop() || (player && player.lastname) || "";
    const nat = (player && player.nationality) || "";
    const altId = surname ? await resolveProfileId(surname, nat, headers) : null;
    if (altId && String(altId) !== String(id)) {
      const b = await wcBlocksFor(altId, headers);
      if (!b.complete) complete = false;
      for (const s in b.bySeason) if (!bySeason[s]) bySeason[s] = b.bySeason[s];
      if (!player && b.player) player = b.player;
    }
  }
  const blocks = Object.values(bySeason);
  let position = "";
  for (const b of blocks) { if (b.games && b.games.position) { position = b.games.position; break; } }
  return { player, position, stats: aggWcStats(blocks), complete };
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
    const ckey = new Request(`https://wc.cache/player7-id-${id}`);
    const hit = await cache.match(ckey);
    if (hit) return hit;
    try {
      const car = await wcCareer(id, headers);
      if (!car.player) return json({ error: "not_found" }, 200, 0);
      const clubs = await fetchClubs(id, headers, car.player.nationality);
      // only cache a COMPLETE aggregate; a partial (throttled) one stays uncached
      const res = json(buildPlayer(car.player, car.stats, clubs, car.position), 200, car.complete ? 86400 : 0);
      if (car.complete) ctx.waitUntil(cache.put(ckey, res.clone()));
      return res;
    } catch (_) {
      return json({ error: "failed" }, 200, 0);
    }
  }

  // ── fuzzy lookup by name (scorers / records / search) ──
  const last = name.split(/\s+/).pop().toLowerCase();
  const term = last.normalize("NFD").replace(/[̀-ͯ]/g, ""); // ASCII surname for search
  if (term.length < 3) return json({ error: "short" }, 200, 0);
  const ckey = new Request(`https://wc.cache/player7-${term}-${norm(nat)}`);
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
    const car = await wcCareer(best.id, headers, true); // best.id is already canonical
    // only cache a COMPLETE aggregate; a partial (throttled) one stays uncached
    const res = json(buildPlayer(best, car.stats, clubs, car.position), 200, car.complete ? 86400 : 0);
    if (car.complete) ctx.waitUntil(cache.put(ckey, res.clone()));
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
  // short TTL: during the tournament the top-scorers list updates live as goals
  // go in, so keep it fresh (was 6h, which served stale tallies).
  const ckey = new Request("https://wc.cache/records-v2");
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
    const res = json(data, 200, 900);
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
