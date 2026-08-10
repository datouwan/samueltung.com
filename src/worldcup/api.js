// World Cup 2026 feature — API handlers. ARCHIVE MODE.
//
// The tournament ended July 19, 2026 (Final: Spain 1–0 Argentina a.e.t.;
// third place: England 6–4 France). The feature is now a frozen archive:
//
//   GET /api/wc       ->  archived snapshot: { archived, podium, groups[],
//                         matches[] (all 104, FINISHED), live:[], scorers[], koSched[] }
//   GET /api/bracket  ->  archived knockout bracket (rounds[])
//   GET /api/squad    ->  archived roster (photos + ages) for all 48 teams
//   GET /api/news     ->  publisher RSS (free, still live)
//   GET /api/wiki     ->  fuzzy player/team lookup (Wikipedia, free, still live)
//   GET /api/records  ->  all-time records (Wikipedia, free, still live)
//   GET /api/player   ->  { error: "archived" }  (was api-football — unsubscribed)
//   GET /api/events   ->  { error: "archived" }  (was api-football — unsubscribed)
//   GET /api/lineups  ->  { error: "archived" }  (was api-football — unsubscribed)
//
// The snapshots in ./archive/ were captured on 2026-07-20 from football-data.org
// (matches/standings/scorers), Wikipedia (bracket), and api-football (squads,
// while the Pro key was still active). No paid upstream is called anymore —
// the api-football subscription lapses ~2026-07-28 and FOOTBALL_DATA_TOKEN is
// no longer needed. The frontend detects `archived: true` and stops polling.
// Player-photo/crest URLs point at media.api-sports.io / crests.football-data.org
// public CDNs; if those ever rot, the page still renders (photos just 404 to
// initials).

import WC_ARCHIVE from "./archive/wc.json";
import BRACKET_ARCHIVE from "./archive/bracket.json";
import SQUADS_ARCHIVE from "./archive/squads.json";

// Route a request to a World Cup API handler, or return null if the path
// isn't one of ours (so the Worker entry can fall back to static assets).
export async function handleWorldCupApi(request, env, ctx) {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/api/wc": return json(WC_ARCHIVE, 200, 3600);
    case "/api/bracket": return json(BRACKET_ARCHIVE, 200, 3600);
    case "/api/squad": return handleSquad(request);
    case "/api/news": return handleNews(request, env, ctx);
    case "/api/wiki": return handleWiki(request, env, ctx);
    case "/api/records": return handleRecords(request, env, ctx);
    // Former api-football endpoints. The frontend treats any {error} payload
    // gracefully (player card falls back to Wikipedia; line-ups fall back to
    // the archived squads), so a static error is all these need.
    case "/api/player":
    case "/api/events":
    case "/api/lineups":
      return json({ error: "archived" }, 200, 86400);
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

// ───────── Squads: archived roster by country name ─────────
// Same response shape the live endpoint had: { source, team, logo, players[] }.
// All 48 nations are in the snapshot, keyed by norm(name).
function handleSquad(request) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("team") || "").trim();
  if (!name) return json({ error: "no_team" }, 400, 0);
  const team = SQUADS_ARCHIVE[norm(name)];
  if (!team) return json({ error: "not_found" }, 200, 0);
  return json(team, 200, 86400);
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

// All-time records scraped from Wikipedia (free, unlimited). The articles are
// final now the tournament is over, so a long cache (24h) is fine. Graceful
// empty payload on failure so the page falls back to curated values.
async function handleRecords(request, env, ctx) {
  const cache = caches.default;
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
    const res = json(data, 200, 86400);
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

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// normalize a name for cross-source matching (mirror of the frontend's norm)
// Keep in sync with the frontend ALIAS so any spelling the page sends
// ("Czechia" / "Czech Republic", "Côte d'Ivoire" / "Ivory Coast") normalizes
// to the same canonical key the squads snapshot is stored under.
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
