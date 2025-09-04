// pages/api/value-bets-locked.js
// KV-only fetch za UI (Combined/Football) sa AUTO cap-om po slotu i vikendu.
// - Preferira vbl_full:<YMD>:<slot> (fallback: vbl i aliasi)
// - Cap: late=6, am/pm=15 (radni dan), am/pm=20 (vikend)
// - Ako je prosleđen ?n=..., koristi min(n, cap); bez n => cap
// - items = sortirano po confidence (tie EV) i isečeno na effN
// - football = puna lista (bez sečenja); top3 = uvek dostupno

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    });
    return fmt.format(d); // YYYY-MM-DD
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function slotOfHour(h) { return h < 10 ? "late" : (h < 15 ? "am" : "pm"); }
function localHour(tz = TZ) {
  try { return Number(new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())); }
  catch { return new Date().getUTCHours(); }
}
function isWeekendLocal(tz = TZ) {
  try {
    const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(new Date());
    return wd === "Sat" || wd === "Sun";
  } catch {
    const gd = new Date().getUTCDay(); return gd === 0 || gd === 6;
  }
}
function capFor(slot, tz = TZ) {
  if (slot === "late") return Number(process.env.SLOT_LATE_LIMIT ?? 6);
  const wk = isWeekendLocal(tz);
  return wk
    ? Number(process.env.SLOT_WEEKEND_LIMIT ?? 20)
    : Number(process.env.SLOT_WEEKDAY_LIMIT ?? 15);
}

async function kvGETraw(key){
  const base = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return null;
  const r = await fetch(`${base.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(()=>null);
  if (!r || !r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
  return (body && typeof body==="object" && "result" in body) ? body.result : body;
}
function toObj(v){ try{ return typeof v==="string" ? JSON.parse(v) : v; } catch { return null; } }
function arrFromAny(o){
  if (!o || typeof o!=="object") return [];
  return Array.isArray(o.items) ? o.items :
         Array.isArray(o.value_bets) ? o.value_bets :
         Array.isArray(o.football) ? o.football :
         Array.isArray(o.arr) ? o.arr :
         Array.isArray(o.data?.items) ? o.data.items :
         Array.isArray(o.data?.football) ? o.data.football :
         Array.isArray(o.data) ? o.data : [];
}
function sortForCombined(arr){
  return [...arr].sort((a,b)=>
    (Number(b?.confidence_pct||0) - Number(a?.confidence_pct||0)) ||
    (Number(b?._ev ?? b?.ev ?? -1) - Number(a?._ev ?? a?.ev ?? -1))
  );
}

export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const slot = (req.query.slot && String(req.query.slot)) || slotOfHour(localHour(TZ));
    const cap = Math.max(1, capFor(slot, TZ));
    const nReq = Number(req.query.n);
    const effN = Number.isFinite(nReq) ? Math.max(1, Math.min(nReq, cap)) : cap;
    const wantDebug = String(req.query.debug||"") === "1";

    const keys = [
      `vbl_full:${ymd}:${slot}`,     // prefer full
      `vbl:${ymd}:${slot}`,          // slim (Top-N) fallback
      `vb-locked:${ymd}:${slot}`,    // aliasi
      `vb:locked:${ymd}:${slot}`,
      `vb_locked:${ymd}:${slot}`,
      `locked:vbl:${ymd}:${slot}`
    ];

    let base=null, picked=null;
    for (const k of keys) {
      const raw = await kvGETraw(k);
      if (!raw) continue;
      const obj = toObj(raw);
      const arr = arrFromAny(obj);
      if (arr && arr.length) { base = arr; picked = k; break; }
    }

    if (!Array.isArray(base) || base.length===0) {
      return res.status(200).json({
        ok:true, slot, ymd, items:[], football:[], top3:[],
        source: `vb-locked:kv:miss·${picked?picked:'none'}${wantDebug?':no-data':''}`,
        policy_cap: cap
      });
    }

    const fullSorted = sortForCombined(base);
    const top3 = fullSorted.slice(0, 3);
    const items = fullSorted.slice(0, effN);

    return res.status(200).json({
      ok:true, slot, ymd,
      items,             // za UI (Football/Combined) - auto cap
      football: base,    // puna lista (debug/ostalo)
      top3,              // uvek dostupno (Combined može da koristi)
      source: picked?.startsWith("vbl_full:") ? `vb-locked:kv:hit·full` : `vb-locked:kv:hit`,
      policy_cap: cap,
      ...(wantDebug ? { debug: { picked, effN, football_len: base.length } } : {})
    });

  } catch(e){
    return res.status(200).json({
      ok:true,
      slot: (req.query.slot||""), ymd: ymdInTZ(new Date(), TZ),
      items:[], football:[], top3:[],
      source:`vb-locked:error ${String(e?.message||e)}`
    });
  }
}
