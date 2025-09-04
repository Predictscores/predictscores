// pages/api/value-bets-locked.js
// KV-only fetch za UI (Combined/Football).
// - NE prelazi na druge slotove: traži samo današnji <slot>
// - Combined (items) = TOP-N po confidence iz vbl_full liste (mešani marketi: 1X2/BTTS/OU/HT-FT)
// - Football = TOP-N iz iste liste (N se ograničava server-side pravilom)

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(d);
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}
function slotOfHour(h) { return h < 10 ? "late" : (h < 15 ? "am" : "pm"); }
function localHour(tz = TZ) {
  try { return Number(new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())); }
  catch { return new Date().getUTCHours(); }
}
function isWeekend(tz = TZ) {
  try {
    const wd = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: tz }).format(new Date());
    return wd === "Sat" || wd === "Sun";
  } catch { return false; }
}
function policyCap(slot, tz = TZ) {
  if (String(slot).toLowerCase() === "late") return 6;
  return isWeekend(tz) ? 20 : 15; // am/pm
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
         Array.isArray(o.data) ? o.data : [];
}

export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const slot = ((req.query.slot && String(req.query.slot)) || slotOfHour(localHour(TZ))).toLowerCase();

    // korisnički zahtev (default 3), zatim server-side cap po pravilu 15/20/6
    const askedN = Number(req.query.n);
    const baseN = Number.isFinite(askedN) ? Math.max(1, Math.min(askedN, 50)) : 3;
    const cap = policyCap(slot, TZ);
    const nMax = Math.min(baseN, cap);

    const keys = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      // aliasi: koristimo ih samo za ISTI slot i ISTI dan (bez cross-slot fallbacka)
      `vb-locked:${ymd}:${slot}`,
      `vb:locked:${ymd}:${slot}`,
      `vb_locked:${ymd}:${slot}`,
      `locked:vbl:${ymd}:${slot}`
    ];

    let full=null, slim=null, picked=null;
    for (const k of keys) {
      const raw = await kvGETraw(k);
      if (!raw) continue;
      const obj = toObj(raw);
      if (!obj) continue;
      if (!picked) picked=k;
      if (!full && /vbl_full:/.test(k)) full=obj;
      if (!slim && /^vbl:/.test(k)) slim=obj;
    }

    const base = full || slim || null;
    const football = arrFromAny(base);

    if (!Array.isArray(football) || football.length===0) {
      return res.status(200).json({
        ok:true, slot, ymd, items:[], value_bets:[], football:[],
        source: `vb-locked:kv:miss·${picked?picked:'none'}`
      });
    }

    // TOP-N po confidence (tie-break EV), ograničeno server-side pravilom
    const combined = [...football]
      .sort((a,b)=> (Number(b?.confidence_pct||0) - Number(a?.confidence_pct||0)) || (Number(b?._ev||-1) - Number(a?._ev||-1)))
      .slice(0, nMax);

    return res.status(200).json({
      ok:true, slot, ymd,
      items: combined,
      value_bets: combined,
      football,
      source: full ? `vb-locked:kv:hit·full` : `vb-locked:kv:hit`
    });

  } catch(e){
    return res.status(200).json({
      ok:true,
      slot: (req.query.slot||""), ymd: ymdInTZ(new Date(), TZ),
      items:[], value_bets:[], football:[],
      source:`vb-locked:error ${String(e?.message||e)}`
    });
  }
}
