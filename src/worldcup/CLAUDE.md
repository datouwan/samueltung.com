# World Cup — backend (`src/worldcup/`)

`api.js` is the Worker side of the World Cup 2026 feature. The client lives in
`public/worldcup/` (see that folder's `CLAUDE.md` too — they share contracts).

## Data sources
Two providers:
- **football-data.org** — group standings + schedule. Free tier is fine (10/min, no daily cap).
  `FD_TTL=30`.
- **api-football (api-sports.io)** — live minute/score, player cards, line-ups, goal events,
  squads. The quota-limited one. Calls `v3.football.api-sports.io` with header `x-apisports-key`
  (a **direct api-sports.io** account, NOT RapidAPI). Secret: `APIFOOTBALL_KEY`.
  Currently on the **Pro plan** (7,500/day, 300/min).

Deployed cadence (Pro): `AF_TTL` ≈ 15s, `FD_TTL` = 30s, squad cache 24h, Wikipedia roster 6h.
~15s is near the practical floor for live fixtures.

## Two fixes that make short polling safe — do NOT regress
1. The live feed must use the **WC-only date query**, NOT the global `/fixtures?live=all`.
   `handleWC` queries `/fixtures?league=1&season=2026&date=<today>` AND `<yesterday>`
   (yesterday catches matches live across UTC midnight), cached `AF_TTL`. The old `live=all` is
   a huge global payload that tripped api-football's **300/min** limit at short intervals → fell
   back to football-data (no fixtureId) and was slow.
2. The client has an 8s AbortController fetch timeout; keep the backend responses fast and
   cached so it isn't tripped.
3. api-football returns HTTP **200 with an `errors` payload** when the per-minute limit is hit.
   `cachedJson` must never cache those (they'd poison every poll for the TTL), and the live
   fixtures queries pass `{isBad, lastGoodTtl}` so a throttled minute serves the last good
   snapshot instead of silently dropping to football-data (which loses kit colors + minute).
   `?debug=1` on `/api/wc` returns a `dbg` object showing why live fell back.

## Live kit colors — source order (fixtureColors, cached `kit4-<fid>` 3h; bump KIT_KEY on logic changes)
1. **Sportradar gismo** (`lsc.fn.sportradar.com/common/.../gismo`, keyless — the feed behind
   their Live Match Tracker widgets). `match_info/<id>` → `data.jerseys.{home,away}.player.base`
   with a `real:true` scout-confirmed flag; only `real` jerseys are accepted. Match id comes from
   `sport_matches/1/<date>/0` filtered to World Cup tournaments (skip "SRL" simulated clones).
   Verified live (2026 R16): only source that knew Canada wore BLACK vs Morocco in WHITE while
   Sofascore was blocked and api-football said red/red brand colors.
2. **Sofascore** event lineups `playerColor.primary` — 403s datacenter AND residential IPs since
   ~Jul 2026; kept as best-effort in case the block lifts.
3. **api-football** lineups `team.colors.player.primary` — usually static brand colors, NOT the
   match kit. Sanitized hard: scramble detection (real shirt in `player.number` when outfield
   number ≈ own GK shirt — Portugal 2026 R32), whitish colors dropped (bogus placeholders),
   and the whole result rejected when both teams' colors clash (dist < 80 = brand data for a
   clash pairing, impossible in a real match).
4. Nothing → the page falls back to static brand colors in `public/worldcup/data.js` KIT.
The frontend TRUSTS feed colors including white (vetting is server-side now). White kits stay
white on jersey icons/cards; only map ARCS swap whitish → light gray (`arcVisible`) so dashed
lines stay visible on the light basemap. "Whitish" = light AND unsaturated (chroma < 36) —
light-but-colorful alt kits (teal/yellow) are real; don't regress that.

## Endpoints
- `/api/wc` — standings, schedule, live fixtures, knockout schedule (`koSched`).
- `/api/lineups?fixture=<id>` — both teams' XI + subs; cached ~60s; full-squad fallback when the
  XI isn't posted yet.
- `/api/squad?team=<name>` — **api-football first** (photos + ages), falls back to **Wikipedia**
  (free/unlimited) on any failure/quota-exhaustion: parses the "2026 FIFA World Cup squads"
  article once for all 48 teams (cached 6h under `squads-wiki-vN`) → number/position/age/club,
  no photos.

## Team-name normalization — keep in sync with frontend
`ALIAS`/`norm()` here MUST stay in sync with the `ALIAS` map in
`public/worldcup/index.html`. Wikipedia headings ("Czech Republic", "Ivory Coast") and the names
the page sends ("Czechia", "Côte d'Ivoire") must normalize to the same canonical key, or squad
lookups 404. **Add a team alias on one side → add it on the other.**

## Deploy
After a meaningful change, from the project root (`C:\GitHub\samueltung.com`) run
`npx wrangler deploy` to redeploy the Worker. It does NOT commit/push to git — only commit/push
when explicitly asked.
