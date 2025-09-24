// pages/api/cron/backfill-combined.js
// Backfills vb:day:<YMD>:combined from vb:day:<YMD>:union.

const { CRON_KEY = "" } = process.env;

function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
async function kvGET(key, trace = []) {
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const v = j?.result ?? j?.value ?? null;
      if (v == null) continue;
      const out = typeof v === "string" ? JSON.parse(v) : v;
      trace.push({ kv: "hit", key, flavor: b.flavor, size: Array.isArray(out?.items) ? out.items.length : Array.isArray(out) ? out.length : 0 });
      return out;
    } catch {}
  }
  trace.push({ kv: "miss", key });
  return null;
}
async function kvSET(key, val, trace = []) {
  const saves = [];
  for (const b of kvBackends()) {
    try {
      const body = typeof val === "string" ? val : JSON.stringify(val);
      const u = `${b.url}/set/${encodeURIComponent(key)}`;
      const r = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${b.tok}` },
        body: JSON.stringify({ value: body }),
      });
      saves.push({ key, flavor: b.flavor, ok: r.ok });
    } catch (e) {
      saves.push({ key, flavor: b.flavor, ok: false, error: String(e?.message || e) });
    }
  }
  trace.push({ kv: "set", key, saves });
  return saves;
}
function checkCronKey(req, expected) {
  if (!expected) return false;
  const q = String(req.query.key || "");
  const h = String(req.headers["x-cron-key"] || "");
  const auth = String(req.headers["authorization"] || "");
  if (q && q === expected) return true;
  if (h && h === expected) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7) === expected) return true;
  return false;
}

export default async function handler(req, res) {
  try {
    if (!checkCronKey(req, CRON_KEY)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const ymd = String(req.query?.ymd || req.body?.ymd || "").trim();
    if (!ymd) {
      return res.status(400).json({ ok: false, error: "missing_ymd" });
    }
    const trace = [];
    const unionKey = `vb:day:${ymd}:union`;
    const combinedKey = `vb:day:${ymd}:combined`;
    const unionPayload = await kvGET(unionKey, trace);
    const unionItems = Array.isArray(unionPayload?.items)
      ? unionPayload.items
      : Array.isArray(unionPayload)
      ? unionPayload
      : [];
    const count = unionItems.length;
    if (count <= 0) {
      return res.status(200).json({ ok: true, ymd, wrote: false, union_count: count, trace });
    }
    const payload =
      unionPayload && typeof unionPayload === "object" && unionPayload.items
        ? JSON.parse(JSON.stringify(unionPayload))
        : { items: JSON.parse(JSON.stringify(unionItems)) };
    await kvSET(combinedKey, payload, trace);
    trace.push({ alias_combined: { from: "union", count } });
    return res.status(200).json({
      ok: true,
      ymd,
      wrote: true,
      union_count: count,
      combined_count: count,
      trace,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
