# samueltung.com

Personal site for **samueltung.com**, served by a Cloudflare Worker
(`samueltung-com`). Mostly static assets — no build step, edit the HTML/CSS in
`public/` directly — plus a tiny API Worker for live data.

```
public/
  index.html         Home
  styles.css         Elegant light theme
  404.html           Not-found page
  worldcup2026.html  World Cup 2026 map + live group tables & scores
src/
  index.js           Worker: serves /api/wc (live World Cup data)
```

## World Cup 2026 live data
`worldcup2026.html` shows an interactive map of the 48 qualified teams plus the 12
group tables and the current live game/score. Live data comes from
[football-data.org](https://www.football-data.org/) (free tier includes the World
Cup, competition `WC`), proxied by `src/index.js` so the API token stays
server-side. The page polls `/api/wc` every 30s.

**Setup:** get a free token at football-data.org, then:
```
# production secret
npx wrangler secret put FOOTBALL_DATA_TOKEN

# local dev — create .dev.vars (git-ignored):
#   FOOTBALL_DATA_TOKEN=your_token_here
```
Without a token the map still works; the tables show a short "configure the feed" note.

## Develop
```
npm install
npm run dev        # local preview (http://localhost:8787)
```

## Deploy
- **Automatic:** pushing to `main` deploys via GitHub Actions
  (`.github/workflows/deploy.yml`). Requires a repo secret **`CLOUDFLARE_API_TOKEN`**
  (Workers-deploy scope).
- **Manual:** `npm run deploy` → `https://samueltung-com.<subdomain>.workers.dev`

## Custom domain
Once `samueltung.com` is **Active** on Cloudflare, uncomment the `routes` block in
`wrangler.jsonc` (samueltung.com + www) and deploy.
