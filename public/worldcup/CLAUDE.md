# World Cup — frontend (`public/worldcup/`)

This is the World Cup 2026 feature's client. The backend lives in `src/worldcup/api.js`
(see that folder's `CLAUDE.md` too — they share contracts).

## Files
- `index.html` — the page. **One large inline `<script>`** that runs top-to-bottom at load.
- `data.js` — static data extracted out of the page.
- `worldcup.css` — styles extracted out of the page.
- `report.html` — separate report view.

## CRITICAL: verify the inline script, don't just syntax-check it
`index.html` is a single inline script executed at page load. A runtime error during that
top-level run aborts the WHOLE script and leaves the page stuck on "Loading…".

A real bug shipped this way: a Leaflet legend control's `onAdd` ran synchronously at load and
read `lastBracket`, which was a `let` declared ~1200 lines lower → temporal-dead-zone
`ReferenceError` → page never loaded. A `new Function(src)` syntax check PASSED because TDZ is a
runtime, not a syntax, error.

**Before deploy:**
1. Anything invoked during synchronous load (Leaflet control `onAdd`, IIFEs, top-level calls)
   must only reference `let`/`const` declared *earlier*. Hoist shared state (e.g. `lastBracket`)
   above its first use.
2. Actually EXECUTE the largest inline script in a stubbed-browser node harness (Proxy
   auto-stub for `L` / `document` / `window` / `fetch` …) and confirm it runs without
   ReferenceError — not just that it parses.

## Backend contract
The page calls the Worker:
- `GET /api/wc` — group standings, schedule, live fixtures, knockout schedule (`koSched`).
- `GET /api/lineups?fixture=<id>` — both teams' XI + subs (lazy on click from a live card).
- `GET /api/squad?team=<name>` — squad roster for the Squads tab.

The live feed uses a WC-only date query on the backend (NOT `/fixtures?live=all`) — don't add
client logic that assumes the old global live payload.

Live polling: `setInterval(refresh, 15000)`. `refresh()` uses an AbortController fetch timeout
(~8s), keeps last-good data through blips, and only shows "offline" after 3 cold failures.
Do NOT remove the timeout — without it a single stalled request freezes the page for minutes.

## Team-name normalization — keep in sync with backend
The frontend `ALIAS` map MUST stay in sync with `ALIAS`/`norm()` in `src/worldcup/api.js`.
Wikipedia headings ("Czech Republic", "Ivory Coast") and the names the page sends ("Czechia",
"Côte d'Ivoire") must normalize to the same canonical key, or squad lookups 404.
**Add a team alias on one side → add it on the other.**

## Deploy
After a meaningful change, deploy: from the project root (`C:\GitHub\samueltung.com`) run
`npx wrangler deploy`. This uploads `public/` and redeploys the Worker. It does NOT commit/push
to git — only commit/push when explicitly asked.
