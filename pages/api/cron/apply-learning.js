// pages/api/cron/apply-learning.js
// KV-only: reads UNION, joins snapshot if available, writes vbl_full:<ymd>:<slot> + day, and freshness markers.
// ZERO external API calls.

export const config = { api: { bodyParser:false } };

/* ---------- TZ & slot ---------- */
function belgradeYMD(d=new Date()){ try{ return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Belgrade"}).format(d);}catch{return new Intl.DateTimeFormat("en-CA").format(d);} }
function inferSlotByTime(d=new Date()){
  const [H]=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Belgrade",hour:"2-digit",minute:"2-digit",hour12:false}).format(d).split(":").map(Number);
  if(H<10) return "late"; if(H<15) return "am"; return "pm";
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
async function kvSetREST(k,v){ if(!hasKV) return false; const r=await fetch(`${KV_URL}/set/${encodeURIComponent(k)}`,{method:"POST",headers:{Authorization:`Bearer ${KV_TOK}`,"Content-Type":"application/json"},body:typeof v==="string"?v:JSON.stringify(v)}); return r.ok; }
async function kvGetUp(k){ if(!hasR) return null; const r=await fetch(`${R_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${R_TOK}`},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return typeof j?.result==="string"?j.result:null; }
async function kvSetUp(k,v){ if(!hasR) return false; const r=await fetch(`${R_URL}/set/${encodeURIComponent(k)}`,{method:"POST",headers:{Authorization:`Bearer ${R_TOK}`,"Content-Type":"application/json"},body:typeof v==="string"?v:JSON.stringify(v)}); return r.ok; }
const kvGetAny=(k)=>kvGetREST(k).then(v=>v!=null?v:kvGetUp(k));
const kvSetBoth=(k,v)=>Promise.all([kvSetREST(k,v),kvSetUp(k,v)]).then(([a,b])=>a||b);

/* ---------- helpers ---------- */
const idsFrom = raw => { const v=typeof raw==="string"?(J(raw)??raw):raw; if(!v) return []; if(Array.isArray(v)) return v.filter(Boolean); if(Array.isArray(v.items)) return v.items.filter(Boolean); return []; };
const rowsFrom = raw => { const v=typeof raw==="string"?(J(raw)??raw):raw; if(!v) return []; if(Array.isArray(v)) return v; if(Array.isArray(v.items)) return v.items; return []; };
const fxId = r => r?.id ?? r?.fixture_id ?? r?.fixture?.id ?? null;

async function loadSnapshotRows(ymd){
  const idxKey=`vb:day:${ymd}:snapshot:index`, legKey=`vb:day:${ymd}:snapshot`;
  const idxRaw=await kvGetAny(idxKey); const idx=typeof idxRaw==="string"?(J(idxRaw)??idxRaw):idxRaw;
  if(idx && Array.isArray(idx.items)) return idx.items;
  if(Array.isArray(idx) && idx.length && typeof idx[0]==="object") return idx;
  let chunkKeys=[];
  if(typeof idx==="string" && idx!==idxKey) chunkKeys=[idx];
  else if(idx && Array.isArray(idx.chunks)) chunkKeys=idx.chunks.filter(Boolean);
  else if(Array.isArray(idx) && idx.length && typeof idx[0]==="string") chunkKeys=idx.filter(Boolean);
  const rows=[]; for(const ck of chunkKeys){ if(ck===idxKey) continue; const cRaw=await kvGetAny(ck); rows.push(...rowsFrom(cRaw)); }
  if(rows.length) return rows;
  const legRaw=await kvGetAny(legKey); const legacy=rowsFrom(legRaw);
  return legacy;
}

/* ---------- handler ---------- */
export default async function handler(req,res){
  try{
    if(!hasKV && !hasR) return res.status(200).json({ok:false,error:"No KV configured."});

    const now=new Date();
    const ymd=String(req.query.ymd||belgradeYMD(now));
    const qSlot=String(req.query.slot||"").toLowerCase();
    const slot=(qSlot==="am"||qSlot==="pm"||qSlot==="late")?qSlot:inferSlotByTime(now);

    const unionKey=`vb:day:${ymd}:union`;
    const vblSlotKey=`vbl_full:${ymd}:${slot}`;
    const vblDayKey =`vbl_full:${ymd}`;
    const historyKey=`vb:history:${ymd}`;
    const lockKey   =`vb:day:${ymd}:last`;
    const vbHitDay  =`vb-locked:kv:hit:${ymd}`;
    const vbHit     =`vb-locked:kv:hit`;

    const unionRaw=await kvGetAny(unionKey);
    const ids=idsFrom(unionRaw);

    let items=[];
    if(ids.length){
      const snapRows=await loadSnapshotRows(ymd);
      if(snapRows.length){
        const want=new Set(ids);
        for(const r of snapRows){ const id=fxId(r); if(id==null || !want.has(id)) continue; items.push(r); }
      }
      if(!items.length) items = ids.slice(); // fall back to ids-only payload
    }

    const ts=new Date().toISOString();
    await kvSetBoth(vblSlotKey,{ ymd, slot, ts, items });

    // merge into day
    let dayItems=items;
    const prevDayRaw=await kvGetAny(vblDayKey);
    if(prevDayRaw){
      const prev=J(prevDayRaw);
      if(prev && Array.isArray(prev.items)){
        const seen=new Map();
        const add=x=>{ const k=typeof x==="object"?(fxId(x)??JSON.stringify(x)):String(x); if(!seen.has(k)) seen.set(k,x); };
        prev.items.forEach(add); dayItems.forEach(add);
        dayItems=Array.from(seen.values());
      }
    }
    await kvSetBoth(vblDayKey,{ ymd, ts, items:dayItems });

    await kvSetBoth(historyKey,{ ymd, ts, slot, count:Array.isArray(items)?items.length:0 });
    await kvSetBoth(lockKey,   { ymd, ts, last_slot:slot, count:Array.isArray(items)?items.length:0 });

    const marker={ ymd, ts, last_odds_refresh: ts, items:Array.isArray(items)?items.length:0 };
    await Promise.all([ kvSetBoth(vbHitDay,marker), kvSetBoth(vbHit,marker) ]);

    return res.status(200).json({
      ok:true, ymd, slot, count:Array.isArray(items)?items.length:0,
      wrote:{ vblSlotKey, vblDayKey, historyKey, lockKey, vbHitDay, vbHit },
      sourceKey: unionKey
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
