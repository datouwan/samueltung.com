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
