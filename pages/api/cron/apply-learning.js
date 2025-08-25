// FILE: pages/api/cron/apply-learning.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const FEATURE_HISTORY = process.env.FEATURE_HISTORY === "1";

/* ---------- KV ---------- */
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const raw = j && typeof j.result !== "undefined" ? j.result : null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
  return r.ok;
}
async function kvDel(key){
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  }).catch(()=>{});
}

/* ---------- time ---------- */
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function hhInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return parseInt(fmt.format(d), 10);
}
function slotForNow(d = new Date(), tz = TZ) {
  const h = hhInTZ(d, tz);
  if (h >= 0 && h < 10) return "late";
  if (h >= 10 && h < 15) return "am";
  return "pm";
}
function toTZParts(iso, tz = TZ){
  const dt = new Date(String(iso||"").replace(" ","T"));
  const y = ymdInTZ(dt, tz);
  const h = hhInTZ(dt, tz);
  return { ymd: y, hour: h };
}
function inSlotWindow(pick, ymd, slot){
  const iso = pick?.datetime_local?.starting_at?.date_time
           || pick?.datetime_local?.date_time
           || pick?.time?.starting_at?.date_time
           || null;
  if (!iso) return false;
  const tz = toTZParts(iso, TZ);
  if (tz.ymd !== ymd) return false;
  if (slot === "am")   return tz.hour >= 10 && tz.hour < 15;
  if (slot === "pm")   return tz.hour >= 15 && tz.hour < 24;
  if (slot === "late") return tz.hour >= 0  && tz.hour < 10;
  return true;
}

/* ---------- learning weights ---------- */
function applyWeights(items, weights) {
  if (!Array.isArray(items)) return [];
  if (!weights) return items;
  return items.map((p) => {
    let adj = 0;
    const mk = p?.market_label || p?.market || "";
    if (weights?.markets && typeof weights.markets[mk] === "number") adj += weights.markets[mk];
    if (typeof weights?.global === "number") adj += weights.global;
    const base = p?.confidence_pct ?? p?.confidence ?? 0;
    const conf = Math.max(0, Math.min(100, base + adj));
    return { ...p, confidence_pct: conf };
  });
}

/* ---------- history helpers ---------- */
function toHistoryRecord(slot, pick){
  return {
    fixture_id: pick?.fixture_id,
    teams: { home: pick?.teams?.home?.name, away: pick?.teams?.away?.name },
    league: { id: pick?.league?.id, name: pick?.league?.name, country: pick?.league?.country },
    kickoff: String(pick?.datetime_local?.starting_at?.date_time || "").replace(" ","T"),
    slot: String(slot || "").toUpperCase(),
    market: pick?.market,
    selection: pick?.selection,
    odds: Number(pick?.market_odds),
    locked_at: new Date().toISOString(),
    final_score: null,
    won: null,
    settled_at: null
  };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const now  = new Date();
    const ymd  = ymdInTZ(now);
    const slot = slotForNow(now);

    // ČITAJ SAMO AKTIVNI SLOT
    const slotKey = `vb:day:${ymd}:${slot}`;
    const rawItems = (await kvGet(slotKey)) || [];
    // DEFANZIVNO: filtriraj na prozor
    const slotItems = rawItems.filter(p => inSlotWindow(p, ymd, slot));

    // Learning weights (opciono)
    const weights = await kvGet(`vb:learn:weights`);

    // Boost + sort by confidence
    const boosted = applyWeights(slotItems, weights)
      .slice()
      .sort((a, b) => (Number(b?.confidence_pct || 0) - Number(a?.confidence_pct || 0)));

    // PIŠI :last + :last_meta
    await kvSet(`vb:day:${ymd}:last`, boosted);
    await kvSet(`vb:meta:${ymd}:last_meta`, {
      ymd,
      slot,                        // "am" | "pm" | "late"
      built_at: new Date().toISOString(),
      count: boosted.length,
      source: `slot:${slot}`,
    });

    // HISTORY CAPTURE (uvek iz boosted liste da odgovara Combined-u)
    if (FEATURE_HISTORY) {
      const topN = (slot === "late") ? 1 : 3;
      const top = boosted.slice(0, topN).map(p => toHistoryRecord(slot, p));
      const histKey = `hist:${ymd}:${slot}`;
      await kvSet(histKey, top);

      // indeks dana (max 14)
      const idxKey = `hist:index`;
      let days = await kvGet(idxKey);
      try { days = Array.isArray(days) ? days : JSON.parse(days); } catch { /* ignore */ }
      if (!Array.isArray(days)) days = [];
      if (!days.includes(ymd)) days.push(ymd);
      days.sort().reverse();
      const keep = days.slice(0, 14);
      await kvSet(idxKey, keep);
      for (const d of days.slice(14)) {
        await kvDel(`hist:${d}:am`);
        await kvDel(`hist:${d}:pm`);
        await kvDel(`hist:${d}:late`);
      }
    }

    res.status(200).json({ ok: true, ymd, slot, count: boosted.length });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
