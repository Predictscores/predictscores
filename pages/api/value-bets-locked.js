// FILE: pages/api/value-bets-locked.js
// Hard-fix: zaključani feed iz KV; ako nema validnih stavki za AKTIVNI slot (ili su sve u prošlosti),
// fallback na generator (/api/value-bets) + strogi filter: samo AKTIVNI slot + KO > SADA (Europe/Belgrade).

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

/* ---------- time helpers ---------- */
function ymd(tz = TZ, d = new Date()) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d); // YYYY-MM-DD
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
function nowInTZ(tz = TZ) {
  const now = new Date();
  // “Trik” bez biblioteka: dobij ISO u toj zoni
  const y = ymd(tz, now);
  const h = String(hourInTZ(tz, now)).padStart(2,"0");
  const m = String(now.getUTCMinutes()).padStart(2,"0"); // minut nije kritičan za slot, ali za KO>now je ok i UTC-minute
  return { ymd: y, hour: parseInt(h,10), isoHint: `${y}T${h}:${m}:00` };
}
function activeSlot(now = new Date()){
  const h = hourInTZ(TZ, now);
  if (h >= 0  && h < 10) return "late"; // 00–10
  if (h >= 10 && h < 15) return "am";   // 10–15
  return "pm";                           // 15–24
}
function toTZParts(iso, tz=TZ){
  const dt = new Date(String(iso||"").replace(" ","T"));
  return { ymd: ymd(tz, dt), hour: hourInTZ(tz, dt) };
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
function isFutureKO(pick){
  const iso = pick?.datetime_local?.starting_at?.date_time
           || pick?.datetime_local?.date_time
           || pick?.time?.starting_at?.date_time
           || null;
  if (!iso) return false;
  const dt = new Date(String(iso).replace(" ","T"));
  const now = new Date();
  return dt.getTime() > now.getTime();
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
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } }
  return v;
}
function arr(v){
  const p = parseMaybe(v);
  if (Array.isArray(p?.items)) return p.items;
  if (Array.isArray(p)) return p;
  return [];
}

/* ---------- local fetch (/api/value-bets) ---------- */
async function localGet(req, path){
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host  = req.headers["x-forwarded-host"]  || req.headers.host;
  const base  = `${proto}://${host}`;
  const r = await fetch(`${base}${path}`, { headers: { "cache-control":"no-store" } });
  if (!r.ok) return null;
  return r.json().catch(()=>null);
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const day  = String(req.query.ymd || ymd());
    const slot = activeSlot();
    const nowBits = nowInTZ(TZ);

    // 1) PROBAJ PRAVI :last
    let items = arr(await kvGet(`vb:day:${day}:last`));
    let metaRaw = await kvGet(`vb:meta:${day}:last_meta`).catch(()=>null);
    let meta = parseMaybe(metaRaw) || {};
    let builtAt = meta.built_at || meta.builtAt || null;
    let metaSlot = meta.slot || null;
    let source = "last";

    // Validacija: mora biti AKTIVNI slot i KO u budućnosti
    let valid = Array.isArray(items) && items.some(x => inSlotWindow(x, day, slot) && isFutureKO(x));
    if (!valid) {
      // 2) SLOT KEY (am/pm/late)
      const slotKey = `vb:day:${day}:${slot}`;
      const slotArr = arr(await kvGet(slotKey)).filter(p => inSlotWindow(p, day, slot) && isFutureKO(p));
      if (slotArr.length){
        items = slotArr;
        builtAt = new Date().toISOString();
        metaSlot = slot;
        source = "slot";
        valid = true;
      }
    }

    if (!valid) {
      // 3) UNION
      const unionArr = arr(await kvGet(`vb:day:${day}:union`)).filter(p => inSlotWindow(p, day, slot) && isFutureKO(p));
      if (unionArr.length){
        items = unionArr;
        builtAt = new Date().toISOString();
        metaSlot = slot;
        source = "union";
        valid = true;
      }
    }

    if (!valid) {
      // 4) GENERATOR (kraj priče: preseci bug sa 16:00 i praznim Combined-om)
      const gen = await localGet(req, `/api/value-bets`);
      const vb  = Array.isArray(gen?.value_bets) ? gen.value_bets : [];
      const fil = vb.filter(p => inSlotWindow(p, day, slot) && isFutureKO(p));
      if (fil.length){
        items = fil;
        builtAt = new Date().toISOString();
        metaSlot = slot;
        source = "generator";
        valid = true;
      }
    }

    // sort: confidence desc, KO asc
    items = (items||[]).slice().sort((a,b)=>{
      const ca = Number(a?.confidence_pct||0), cb = Number(b?.confidence_pct||0);
      if (cb!==ca) return cb - ca;
      const ta = +new Date(String(a?.datetime_local?.starting_at?.date_time||"").replace(" ","T"));
      const tb = +new Date(String(b?.datetime_local?.starting_at?.date_time||"").replace(" ","T"));
      return ta - tb;
    });

    return res.status(200).end(JSON.stringify({
      ok: true,
      ymd: day,
      slot: metaSlot || slot,
      built_at: builtAt,
      items,
      source,           // debug: odakle je došlo (last/slot/union/generator)
      locked_version: "v4"
    }));
  } catch (e) {
    return res.status(200).end(JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      ymd: null,
      slot: null,
      built_at: null,
      items: [],
      source: "error",
      locked_version: "v4"
    }));
  }
}
