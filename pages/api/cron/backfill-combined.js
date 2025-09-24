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
    const combinedKey = `vb:day:${ymd}:combined`;
    const slots = ["am", "pm", "late"];
    const counts = {
      amCombined: 0,
      amUnion: 0,
      pmCombined: 0,
      pmUnion: 0,
      lateCombined: 0,
      lateUnion: 0,
    };
    const collected = [];
    const asArray = (payload) =>
      Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
    for (const slot of slots) {
      const slotCombinedKey = `vb:day:${ymd}:${slot}:combined`;
      const slotUnionKey = `vb:day:${ymd}:${slot}:union`;
      const combinedPayload = await kvGET(slotCombinedKey, trace);
      const combinedItems = asArray(combinedPayload);
      counts[`${slot}Combined`] = combinedItems.length;
      let useItems = [];
      let usedSource = "none";
      if (combinedPayload != null && combinedItems.length > 0) {
        useItems = combinedItems;
        usedSource = "combined";
      } else {
        const unionPayload = await kvGET(slotUnionKey, trace);
        const unionItems = asArray(unionPayload);
        counts[`${slot}Union`] = unionItems.length;
        if (unionItems.length > 0) {
          useItems = unionItems;
          usedSource = "union";
        }
      }
      if (useItems.length > 0) {
        collected.push(...useItems);
      }
      trace.push({ slot, used: usedSource, count: useItems.length });
    }
    const total_before_dedupe = collected.length;
    const seen = new Set();
    const merged = [];
    for (const item of collected) {
      const rawFixtureId = item?.model?.fixture ?? item?.fixture ?? item?.fixture_id;
      const dedupeKey = rawFixtureId !== undefined && rawFixtureId !== null ? String(rawFixtureId) : "";
      if (dedupeKey) {
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
      }
      merged.push(item);
    }
    const total_after_dedupe = merged.length;
    const wrote = total_after_dedupe > 0;
    if (wrote) {
      await kvSET(combinedKey, merged, trace);
    }
    return res.status(200).json({
      ok: true,
      ymd,
      wrote,
      ...counts,
      total_before_dedupe,
      total_after_dedupe,
      trace,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
