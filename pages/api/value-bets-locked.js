// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{ headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) {
      trace && trace.push({ get:key, ok:false, err:String(e?.message||e) });
    }
  }
  return { raw:null, flavor:null };
}
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }
// FIX: uvek "danas" kada nema ?ymd=
function targetYmdForSlot(now, slot, tz){ return ymdInTZ(now, tz); }
const isValidYmd = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||""));

/* ---------- caps ---------- */
function dowShort(d, tz){ return new Intl.DateTimeFormat("en-GB",{ timeZone: tz, weekday:"short" }).format(d); }
function slotCap(now, slot){
  const wd = dowShort(now, TZ);
  const weekend = (wd === 'Sat' || wd === 'Sun');
  const CAP_LATE = Number(process.env.CAP_LATE)||6;
  const CAP_AM_WD = Number(process.env.CAP_AM_WD)||15;
  const CAP_PM_WD = Number(process.env.CAP_PM_WD)||15;
  const CAP_AM_WE = Number(process.env.CAP_AM_WE)||20;
  const CAP_PM_WE = Number(process.env.CAP_PM_WE)||20;
  if (slot==="late") return CAP_LATE;
  if (slot==="am")   return weekend ? CAP_AM_WE : CAP_AM_WD;
  if (slot==="pm")   return weekend ? CAP_PM_WE : CAP_PM_WD;
  return 20;
}

/* ---------- sort helpers ---------- */
function confPct(it){ return Number.isFinite(it?.confidence_pct) ? it.confidence_pct : (Number(it?.confidence)||0); }
function kickoffISO(it){ return it?.kickoff_utc || it?.fixture?.date || it?.kickoff || it?.fixture_date || it?.ts || null; }
function kickoffTime(it){ const d = kickoffISO(it) ? new Date(kickoffISO(it)).getTime() : 0; return Number.isFinite(d) ? d : 0; }
function hasMarkets(it){
  const m = it?.markets || {};
  return Number.isFinite(m?.h2h?.home) || Number.isFinite(m?.btts?.yes) || Number.isFinite(m?.ou25?.over) ||
         Number.isFinite(m?.htft?.hh)  || Number.isFinite(m?.htft?.aa)  || Number.isFinite(m?.fh_ou15?.over);
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;

    // NEW: ymd override
    const qYmd = String(req.query.ymd||"").trim();
    const ymd  = isValidYmd(qYmd) ? qYmd : targetYmdForSlot(now, slot, TZ);

    // Football list – prefer capovani pool
    const poolKeys = [
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vbl_full:${ymd}:${slot}`
    ];
    let items=null, source=null;
    for (const k of poolKeys) {
      const { raw } = await kvGETraw(k, trace);
      const j = J(raw);
      const arr = Array.isArray(j) ? j : (Array.isArray(j?.items)? j.items : []);
      if (arr.length){ items=arr.slice(); source=k; break; }
    }

    if (Array.isArray(items)) {
      items.sort((a,b)=>{
        const dc = (confPct(b) - confPct(a)); if (dc) return dc;
        const hm = (hasMarkets(b) === hasMarkets(a)) ? 0 : (hasMarkets(b) ? 1 : -1);
        if (hm) return -hm;
        return kickoffTime(a) - kickoffTime(b);
      });
    }

    const cap = slotCap(now, slot);
    if (Array.isArray(items) && items.length > cap && /vbl_full|vb:day:.*:union/.test(String(source||""))) {
      items = items.slice(0, cap);
      trace.push({ capping:true, cap, source });
    } else if (Array.isArray(items) && items.length > cap && /vbl:/.test(String(source||""))) {
      items = items.slice(0, cap);
      trace.push({ capping:true, cap, source:"vbl (extra-guard)" });
    }

    const { raw:rawT } = await kvGETraw(`tickets:${ymd}:${slot}`, trace);
    const tickets = J(rawT) || null;

    return res.status(200).json({
      ok:true, ymd, slot,
      source, items: Array.isArray(items)? items : [],
      tickets: tickets || { btts:[], ou25:[], htft:[], fh_ou15:[] },
      debug: { trace, cap }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
