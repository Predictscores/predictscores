// pages/api/cron/apply-learning.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGetJSON(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(() => null);
  const val = js && "result" in js ? js.result : js;
  try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return null; }
}
async function kvSetJSON(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body
  });
  return r.ok;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function hhmmInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(d);
}
function slotForNow(d = new Date(), tz = TZ) {
  const t = hhmmInTZ(d, tz);
  if (t >= "00:00" && t < "12:00") return "AM";
  if (t >= "12:00" && t < "18:00") return "PM";
  return "LATE";
}

function applyWeights(items, weights) {
  if (!Array.isArray(items) || !weights) return items || [];
  return items.map(p => {
    let adj = 0;
    const mk = p?.market_label || p?.market || "";
    if (weights?.markets && typeof weights.markets[mk] === "number") adj += weights.markets[mk];
    if (typeof weights?.global === "number") adj += weights.global;
    const base = p?.confidence_pct ?? p?.confidence ?? 0;
    const conf = Math.max(0, Math.min(100, base + adj));
    return { ...p, confidence_pct: conf };
  });
}

export default async function handler(req, res) {
  try {
    const now  = new Date();
    const ymd  = ymdInTZ(now);
    const slot = slotForNow(now);

    const union   = (await kvGetJSON(`vb:day:${ymd}:union`)) || [];
    const weights = (await kvGetJSON(`vb:learn:weights`)) || null;

    const boosted = applyWeights(union, weights)
      .sort((a, b) => (b?.confidence_pct ?? 0) - (a?.confidence_pct ?? 0));

    await kvSetJSON(`vb:day:${ymd}:last`, JSON.stringify(boosted));
    await kvSetJSON(`vb:meta:${ymd}:last_meta`, JSON.stringify({
      ymd, slot, built_at: new Date().toISOString(), source: "union"
    }));

    return res.status(200).json({ ok: true, count: boosted.length, slot, ymd });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
