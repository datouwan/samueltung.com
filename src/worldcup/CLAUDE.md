# World Cup — backend (`src/worldcup/`) — ARCHIVE MODE

The 2026 tournament is over (Final Jul 19, 2026: **Spain 1–0 Argentina a.e.t.**;
third place: **England 6–4 France**). `api.js` now serves frozen snapshots from
`./archive/` — **no paid upstream is called anymore**. The api-football Pro
subscription was left to lapse (~2026-07-28) and `FOOTBALL_DATA_TOKEN` /
`APIFOOTBALL_KEY` are unused (the secrets may still exist on the Worker;
harmless). The squad-warming cron was removed from `wrangler.jsonc`.

## Endpoints
- `/api/wc` — archived `{ archived:true, podium, groups, matches (all 104,
  FINISHED), live:[], scorers, koSched }`. The `archived`/`podium` fields drive
  the frontend's podium hero + poll shutdown.
- `/api/bracket` — archived knockout rounds (originally parsed from Wikipedia).
- `/api/squad?team=` — archived rosters for all 48 teams (api-football photos +
  ages, Wikipedia full names/clubs merged), keyed by `norm(name)`.
- `/api/news`, `/api/wiki`, `/api/records` — still LIVE (free/keyless:
  publisher RSS + Wikipedia). Records cache is 24h now the articles are final.
- `/api/player`, `/api/events`, `/api/lineups` — return `{error:"archived"}`;
  the page falls back gracefully (player card → Wikipedia bio; line-ups →
  archived squads).

## Snapshots (`./archive/`, bundled into the Worker via JSON imports)
Captured 2026-07-20 from football-data.org (matches/standings/scorers),
Wikipedia (bracket) and api-football (squads, while the key was active).
Photo/crest URLs point at public CDNs (media.api-sports.io,
crests.football-data.org); if they ever rot the page still renders.

## Team-name normalization — keep in sync with frontend
`ALIAS`/`norm()` here MUST stay in sync with the `ALIAS` map in
`public/worldcup/index.html` — squad lookups resolve through it
("Czech Republic" → `czechia`, "Ivory Coast" → `cotedivoire`, …).

## Deploy
After a meaningful change, from the project root (`C:\GitHub\samueltung.com`)
run `npx wrangler deploy`. It does NOT commit/push to git — only commit/push
when explicitly asked.

## History
The live-tournament backend (api-football live feed + quota gating, Sportradar/
Sofascore kit-color pipeline, player career aggregation, squad warming cron) was
removed when the site was archived; see git history before 2026-07-20 if any of
it is ever needed again.
