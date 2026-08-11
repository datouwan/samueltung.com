# World Cup — frontend (`public/worldcup/`) — ARCHIVE MODE

This is the World Cup 2026 feature's client, now an **archive** of the finished
tournament (Final Jul 19, 2026: Spain 1–0 Argentina a.e.t.; third: England).
The backend lives in `src/worldcup/api.js` (see that folder's `CLAUDE.md`).

## Files
- `index.html` — the page. **One large inline `<script>`** that runs top-to-bottom at load.
- `data.js` — static data (i18n, teams, kits, schedule) extracted out of the page.
- `worldcup.css` — styles, including the `#podium` archive hero.
- `report.html` — separate report view.

## Archive behavior
`/api/wc` returns `archived:true` + a `podium` object. On seeing it, `refresh()`:
renders the podium hero (`renderPodium`, 🥈🏆🥉 + final/third-place score lines),
hides the live bar (`.livewrap`), caps the finished-games strip to the last 8
matches (QF onward — the calendar holds all 104), swaps the updated-label for
`t('arch_note')`, and **clears the 15s poll timer** — the page fetches `/api/wc`
once per load. `archivedMode`/`lastPodium`/`pollTimer` are declared near the top
(by `liveBar`) — keep them above anything that runs at load. Language switches
re-render the podium via `rerenderI18n()`; podium strings are the `pod_*` /
`arch_note` keys in all three `I18N` languages.

Player cards still work: `/api/player` returns `{error:"archived"}` and the card
falls back to the (live, free) `/api/wiki` bio. Squads come from the archived
snapshot with photos.

## CRITICAL: verify the inline script, don't just syntax-check it
`index.html` is a single inline script executed at page load. A runtime error
during that top-level run aborts the WHOLE script and leaves the page stuck on
"Loading…". TDZ bugs (a load-time callback reading a `let` declared lower) pass
a syntax check and only explode at runtime — one shipped this way once.

**Before deploy:**
1. Anything invoked during synchronous load must only reference `let`/`const`
   declared *earlier*.
2. Actually EXECUTE the inline scripts in a stubbed-browser node harness (Proxy
   auto-stubs for `L`/`document`/`window`/`fetch`, real archived JSON payloads)
   and assert the archive path renders (podium innerHTML, poll cleared). A
   ready-made harness pattern: feed `src/worldcup/archive/wc.json` through a
   stub `fetch` and check `#podium` innerHTML contains the champion.

## Team-name normalization — keep in sync with backend
The frontend `ALIAS` map MUST stay in sync with `ALIAS`/`norm()` in
`src/worldcup/api.js` — archived squad lookups key on the canonical name.

## Deploy
After a meaningful change, deploy: from the project root run
`npx wrangler deploy`. This uploads `public/` and redeploys the Worker. It does
NOT commit/push to git — only commit/push when explicitly asked.
