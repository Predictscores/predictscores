// pages/api/value-bets-locked.js
// KV-only feed. Reads vbl_full:<ymd>:<slot> (fallback vbl_full:<ymd>).
// Enforces fixed slot caps regardless of query.
// Weekdays: AM=15, PM=15, LATE=6; Weekends: AM=20, PM=20, LATE=6.

export const config = { api: { bodyParser:false } };

/* ---------- date/slot ---------- */
function belgradeYMD(d=new Date()){ try{ return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Belgrade"}).format(d);}catch{return new Intl.DateTimeFormat("en-CA").format(d);} }
function inferSlotByTime(d=new Date()){
  const [H]=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Belgrade",hour:"2-digit",minute:"2-digit",hour12:false}).format(d).split(":").map(Number);
  if(H<10) return "late"; if(H<15) return "am"; return "pm";
}
function parseDate(ymd){ const [y,m,d]=ymd.split("-").map(Number); return new Date(Date.UTC(y,m-1,d,12,0,0)); }
function isWeekendYMD(ymd){
  const d=parseDate(ymd);
  const wd=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Belgrade",weekday:"long"}).format(d);
  return wd==="Saturday"||wd==="Sunday";
}
function capsFor(ymd,slot){
  const wknd=isWeekendYMD(ymd);
  const base = wknd ? { am:20, pm:20, late:6 } : { am:15, pm:15, late:6 };
  // allow env override
  const num = (k,def)=>{ const v=process.env[k]; const n=Number(v); return Number.isFinite(n)&&n>0?n:def; };
  return wknd
    ? (slot==="am"?num("VBL_CAP_WEEKEND_AM",base.am):slot==="pm"?num("VBL_CAP_WEEKEND_PM",base.pm):num("VBL_CAP_WEEKEND_LATE",base.late))
    : (slot==="am"?num("VBL_CAP_WEEKDAY_AM",base.am):slot==="pm"?num("VBL_CAP_WEEKDAY_PM",base.pm):num("VBL_CAP_WEEKDAY_LATE",base.late));
}

/* ---------- KV ---------- */
const KV_URL=process.env.KV_REST_API_URL?String(process.env.KV_REST_API_URL).replace(/\/+$/,""):"";
const KV_TOK=process.env.KV_REST_API_TOKEN||"";
const hasKV=Boolean(KV_URL&&KV_TOK);
const R_URL=process.env.UPSTASH_REDIS_REST_URL?String(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/,""):"";
const R_TOK=process.env.UPSTASH_REDIS_REST_TOKEN||"";
const hasR=Boolean(R_URL&&R_TOK);
const J=s=>{try{return JSON.parse(String(s??""));}catch{return null;}};
async function kvGetREST(k){ if(!hasKV) return null; const r=await fetch(`${KV_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${KV_TOK}`},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return typeof j?.result==="string"?j.result:null; }
async function kvGetUp(k){ if(!hasR) return null; const r=await fetch(`${R_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${R_TOK}`},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return typeof j?.result==="string"?j.result:null; }
const kvGetAny=(k)=>kvGetREST(k).then(v=>v!=null?v:kvGetUp(k));

/* ---------- utils ---------- */
const rowsFrom = raw => { const v=typeof raw==="string"?(J(raw)??raw):raw; if(!v) return []; if(Array.isArray(v)) return v; if(Array.isArray(v.items)) return v.items; return []; };

/* ---------- handler ---------- */
export default async function handler(req,res){
  try{
    if(!hasKV && !hasR) return res.status(200).json({ items:[], meta:{ ymd:String(req.query.ymd||belgradeYMD()), slot:String(req.query.slot||""), source:"vb-locked:kv:hit", ts:null, last_odds_refresh:null }, error:"No KV configured." });

    const now=new Date();
    const ymd=String(req.query.ymd||belgradeYMD(now));
    const qSlot=String(req.query.slot||"").toLowerCase();
    const slot=(qSlot==="am"||qSlot==="pm"||qSlot==="late")?qSlot:inferSlotByTime(now);

    const vblSlotKey=`vbl_full:${ymd}:${slot}`;
    const vblDayKey =`vbl_full:${ymd}`;
    const [slotRaw, dayRaw, ftRaw, fgRaw] = await Promise.all([
      kvGetAny(vblSlotKey),
      kvGetAny(vblDayKey),
      kvGetAny(`vb-locked:kv:hit:${ymd}`),
      kvGetAny(`vb-locked:kv:hit`)
    ]);

    let items = rowsFrom(slotRaw);
    if (!items.length) items = rowsFrom(dayRaw);

    // enforce caps regardless of client-provided ?limit
    const cap = capsFor(ymd, slot);
    if (items.length > cap) items = items.slice(0, cap);

    const ft = J(ftRaw) || {};
    const fg = J(fgRaw) || {};
    const ts = ft.ts || fg.ts || null;
    const last_odds_refresh = ft.last_odds_refresh || fg.last_odds_refresh || null;

    return res.status(200).json({
      items,
      meta:{ ymd, slot, source:"vb-locked:kv:hit", ts, last_odds_refresh, returned: items.length, cap }
    });
  }catch(e){
    return res.status(200).json({
      items:[],
      meta:{ ymd:String(req.query.ymd||belgradeYMD()), slot:String(req.query.slot||""), source:"vb-locked:kv:hit", ts:null, last_odds_refresh:null },
      error:String(e?.message||e)
    });
  }
}
