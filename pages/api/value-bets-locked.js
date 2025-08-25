// FILE: pages/api/value-bets-locked.js
// Čita zaključani feed iz KV. Ako je :last prazan, koristi aktivni slot (am/pm/late),
// a ako ni to nema, filtrira :union na aktivni slot da ne ostane prazno.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

/* ---------- time ---------- */
function ymd(tz = TZ, d = new Date()) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hourInTZ(tz = TZ, d = new Date()){
  try {
    const s = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d);
    return parseInt(s, 10);
  } catch { return d.getHours(); }
}
function activeSlot(now = new Date()){
  const h = hourInTZ(TZ, now);
  if (h >= 0  && h < 10) return "late";
  if (h >= 10 && h < 15) return "am";
  return "pm";
}
function toTZParts(iso, tz=TZ){
  const dt = new Date(String(iso||"").replace(" ","T"));
  return {
    ymd: ymd(tz, dt),
    hour: hourInTZ(tz, dt),
  };
}
function inSlotWindow(pick, day, slot){
  const iso = pick?.datetime_local?.starting_at?.date_time
           || pick?.datetime_local?.date_time
           || pick?.time?.starting_at?.date_time
           || null;
  if (!iso) return false;
  const p = toTZParts(iso, TZ);
  if (p.ymd !== day) return false;
  if (slot === "am")   return p.hour >= 10 && p.hour < 15;
  if (slot === "pm")   return p.hour >= 15 && p.hour < 24;
  if (slot === "late") return p.hour >= 0  && p.hour < 10;
  return true;
}

/* ---------- KV ---------- */
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) throw new Error("KV env missing");
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j === "object" && "result" in j ? j.result : j;
}
function parseMaybe(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}
function arr(v){
  const p = parseMaybe(v);
  if (Array.isArray(p?.items)) return p.items;
  if (Array.isArray(p)) return p;
  return [];
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const day = String(req.query.ymd || ymd());
    const slot = activeSlot();

    // 1) PROBAJ PRAVI :last
    const lastRaw = await kvGet(`vb:day:${day}:last`);
    let items = arr(lastRaw);

    // meta
    let metaRaw = await kvGet(`vb:meta:${day}:last_meta`).catch(()=>null);
    let meta = parseMaybe(metaRaw) || {};
    let builtAt = meta.built_at || meta.builtAt || null;
    let metaSlot = meta.slot || null;

    // 2) FALLBACK NA SLOT KLJUČ (am/pm/late)
    if (!items.length){
      const slotKey = `vb:day:${day}:${slot}`;
      const slotArr = arr(await kvGet(slotKey)).filter(p => inSlotWindow(p, day, slot));
      if (slotArr.length){
        items = slotArr;
        builtAt = new Date().toISOString();
        metaSlot = slot;
      }
    }

    // 3) POSLEDNJI FALLBACK: :union → filtriraj na aktivni slot
    if (!items.length){
      const unionArr = arr(await kvGet(`vb:day:${day}:union`)).filter(p => inSlotWindow(p, day, slot));
      if (unionArr.length){
        items = unionArr;
        builtAt = new Date().toISOString();
        metaSlot = slot;
      }
    }

    return res.status(200).end(JSON.stringify({
      ok: true,
      ymd: day,
      source: "last",
      built_at: builtAt,
      slot: metaSlot,
      items
    }));
  } catch (e) {
    return res.status(200).end(JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      ymd: null,
      source: "last",
      built_at: null,
      slot: null,
      items: []
    }));
  }
}
