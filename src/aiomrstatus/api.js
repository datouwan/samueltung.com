// AI-OMR status relay (2026-09-30).
//
// ai-omr-agnostic scripts/status_push.py gathers the project's state (curated narrative +
// automatic metrics) and POSTs it here every 10 minutes and at every milestone; the
// /ai-omr/status page reads it back. Latest snapshot only, in TRAIN_KV under its own key.
//
//   POST /api/ai-omr/status   Authorization: Bearer <TRAIN_PUSH_TOKEN>
//   GET  /api/ai-omr/status   behind the site password (the Worker gates it before we get here)

const KEY = "ai-omr-status";
const MAX_BYTES = 512 * 1024;
export const STATUS_API = "/api/ai-omr/status";

export async function handleAiOmrStatusApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== STATUS_API) return null;

  if (request.method === "POST") {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.TRAIN_PUSH_TOKEN || token !== env.TRAIN_PUSH_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await request.text();
    if (body.length > MAX_BYTES) return new Response("too large", { status: 413 });
    let state;
    try { state = JSON.parse(body); } catch { return new Response("not json", { status: 400 }); }
    await env.TRAIN_KV.put(KEY, JSON.stringify({ pushed_at: new Date().toISOString(), state }));
    return new Response("ok");
  }

  if (request.method === "GET") {
    const stored = await env.TRAIN_KV.get(KEY);
    return new Response(stored || JSON.stringify({ pushed_at: null, state: null }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response("method not allowed", { status: 405 });
}
