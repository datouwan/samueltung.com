// Training-monitor status relay.
//
// The local training monitor (ai-omr-agnostic scripts/training_monitor.py
// --push) POSTs its state JSON here; the /train page reads it back. Latest
// snapshot only, stored in TRAIN_KV under one key.
//
//   POST /api/train-status   Authorization: Bearer <TRAIN_PUSH_TOKEN>
//   GET  /api/train-status   public read (non-sensitive training metrics)

const KEY = "latest";
const MAX_BYTES = 256 * 1024;

export async function handleTrainMonApi(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/train-status") return null;

  if (request.method === "POST") {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.TRAIN_PUSH_TOKEN || token !== env.TRAIN_PUSH_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await request.text();
    if (body.length > MAX_BYTES) return new Response("too large", { status: 413 });
    try { JSON.parse(body); } catch { return new Response("not json", { status: 400 }); }
    const wrapped = JSON.stringify({ pushed_at: new Date().toISOString(), state: JSON.parse(body) });
    await env.TRAIN_KV.put(KEY, wrapped);
    return new Response("ok");
  }

  if (request.method === "GET") {
    const stored = await env.TRAIN_KV.get(KEY);
    return new Response(stored || JSON.stringify({ pushed_at: null, state: null }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return new Response("method not allowed", { status: 405 });
}
