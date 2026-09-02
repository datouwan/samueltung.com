// Purge the Cloudflare edge cache for samueltung.com after a deploy.
//
// Workers static assets are served with `max-age=0, must-revalidate`, but edge
// POPs can keep serving a previous version for a while after `wrangler deploy`.
// The Cloudflare MCP plugin's OAuth grant does not include cache purge, so this
// uses a dedicated API token with ONE permission: Zone > Cache Purge > Purge.
//
// Token lookup order:
//   1. env CLOUDFLARE_PURGE_TOKEN
//   2. file ~/.cloudflare/purge-token   (one line, git-ignored by living outside the repo)
//
// Create the token at https://dash.cloudflare.com/profile/api-tokens
//   Create Token -> Custom token -> Permissions: Zone / Cache Purge / Purge
//   Zone Resources: Include / All zones (or just samueltung.com)
//
// Usage:  node scripts/purge-cache.mjs [url ...]
//   no args  -> purge everything for the zone
//   urls     -> purge only those URLs

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ZONE_NAME = "samueltung.com";

function loadToken() {
  if (process.env.CLOUDFLARE_PURGE_TOKEN) return process.env.CLOUDFLARE_PURGE_TOKEN.trim();
  try {
    return readFileSync(join(homedir(), ".cloudflare", "purge-token"), "utf8").trim();
  } catch {
    return null;
  }
}

async function cf(token, path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json();
  if (!body.success) {
    const msg = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.result;
}

const token = loadToken();
if (!token) {
  console.warn("purge-cache: no token found (CLOUDFLARE_PURGE_TOKEN or ~/.cloudflare/purge-token); skipping purge.");
  process.exit(0);
}

const urls = process.argv.slice(2);
try {
  const zones = await cf(token, `/zones?name=${ZONE_NAME}`);
  if (!zones.length) throw new Error(`zone ${ZONE_NAME} not visible to this token`);
  const zoneId = zones[0].id;
  const payload = urls.length ? { files: urls } : { purge_everything: true };
  await cf(token, `/zones/${zoneId}/purge_cache`, { method: "POST", body: JSON.stringify(payload) });
  console.log(urls.length ? `purge-cache: purged ${urls.length} URL(s) on ${ZONE_NAME}` : `purge-cache: purged everything on ${ZONE_NAME}`);
} catch (err) {
  console.error(`purge-cache: failed: ${err.message}`);
  process.exit(1);
}
