// pages/api/cron/apply-learning.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(() => null);
  return js && typeof js === "object" && "result" in js ? js.result : js;
}
async function kvGetJSON(key) {
  const raw = await kvGetRaw(key);
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}
async function kvSetJSON(key, val) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(val)
  });
  return r.ok;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function hhmmInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(d); // "HH:MM"
}
function slotForNow(d = new Date(), tz = TZ) {
  const time = hhmmInTZ(d, tz);
  if (time >= "00:00" && time < "12:00") return "AM";     // jutarnji (10:00 u praksi)
  if (time >= "12:00" && time < "18:00") return "PM";     // popodnevni (15:00)
  return "LATE";                                          // kasni
}

function applyLearnWeights(items, weights) {
  if (!weights) return items;
  return items.map(p => {
    let adj = 0;
    const mk = p.market || p.market_label || "";
    if (weights.markets && typeof weights.markets[mk] === "number") adj += weights.markets[mk];
    if (typeof weights.global === "number") adj += weights.global;
    const conf = Math.max(0, Math.min(100, (p.confidence_pct ?? p.confidence ?? 0) + adj));
    return { ...p, confidence_pct: conf };
  });
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = ymdInTZ(now);
    const slot = slotForNow(now);

    // 1) Uzmi dnevni union
    const union = (await kvGetJSON(`vb:day:${ymd}:union`)) || [];
    // (opcionalno: filtriraj po slotu ako u objektima postoji p.slot === slot)

    // 2) Učitaj naučene težine (ako postoje)
    const weights = await kvGetJSON(`vb:learn:weights`) || null;

    // 3) Primeni umeren boost na confidence i sortiraj
    const boosted = applyLearnWeights(union, weights);
    boosted.sort((a, b) => (b.confidence_pct ?? 0) - (a.confidence_pct ?? 0));

    // 4) Upisi zaključan feed
    await kvSetJSON(`vb:day:${ymd}:last`, boosted);
    await kvSetJSON(`vb:meta:${ymd}:last_meta`, {
      ymd,
      slot,
      built_at: new Date().toISOString(),
      source: "union"
    });

    return res.status(200).json({ ok: true, count: boosted.length, slot, ymd });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
