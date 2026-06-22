# samueltung.com

Personal site for **samueltung.com**, served by a static-assets-only Cloudflare Worker
(`samueltung-com`). No build step — edit the HTML/CSS in `public/` directly.

```
public/
  index.html     Home
  styles.css     Elegant light theme
  404.html       Not-found page
```

## Develop
```
npm install
npm run dev        # local preview
```

## Deploy
- **Automatic:** pushing to `main` deploys via GitHub Actions
  (`.github/workflows/deploy.yml`). Requires a repo secret **`CLOUDFLARE_API_TOKEN`**
  (Workers-deploy scope).
- **Manual:** `npm run deploy` → `https://samueltung-com.<subdomain>.workers.dev`

## Custom domain
Once `samueltung.com` is **Active** on Cloudflare, uncomment the `routes` block in
`wrangler.jsonc` (samueltung.com + www) and deploy.
