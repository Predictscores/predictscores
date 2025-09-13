// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();

/* KV */
function kvBackends(){ const out=[]; const aU=process.env.KV_REST_API_URL, aT=process.env.KV_REST_API_TOKEN; const bU=process.env.UPSTASH_REDIS_REST_URL, bT=process.env.UPSTASH_REDIS_REST_TOKEN; if(aU&&aT) out.push({flavor:"vercel-kv",url:aU.replace(/\/+$/,""),tok:aT}); if(bU&&bT) out.push({flavor:"upstash-redis",url:bU.replace(/\/+$/,""),tok:bT}); return out; }
async function kvGETraw(key){ for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${b.tok}`},cache:"no-store"}); if(!r.ok) continue; const j=await r.json().catch(()=>null); const raw=typeof j?.result==="string"?j.result:null; if(raw) return {raw,flavor:b.flavor}; }catch{} } return {raw:null,flavor:null}; }
const J=s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };

const ymdInTZ=(d,tz)=>new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(d);
const hourInTZ=(d,tz)=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour12:false,hour:"2-digit"}).format(d));
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }

function isWeekendYmd(ymd,tz){ const [y,m,d]=ymd.split("-").map(Number); const dt=new Date(Date.UTC(y,m-1,d)); const wd=new Intl.DateTimeFormat("en-US",{timeZone:tz,weekday:"short"}).format(dt); return wd==="Sat"||wd==="Sun"; }
function capsFor(slot,weekend){
  const capLate=Number(process.env.CAP_LATE||6);
  const capAmWd=Number(process.env.CAP_AM_WD||15);
  const capPmWd=Number(process.env.CAP_PM_WD||15);
  const capAmWe=Number(process.env.CAP_AM_WE||20);
  const capPmWe=Number(process.env.CAP_PM_WE||20);
  if(slot==="late") return capLate;
  if(!weekend) return slot==="am"?capAmWd:capPmWd;
  return slot==="am"?capAmWe:capPmWe;
}

const confidence=it=>Number.isFinite(it?.confidence_pct)?it.confidence_pct:(Number(it?.confidence)||0);
const kickoffTs=it=>{ const k=it?.fixture?.date||it?.fixture_date||it?.kickoff||it?.kickoff_utc||it?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };
const byConfKick=(a,b)=>(confidence(b)-confidence(a))||(kickoffTs(a)-kickoffTs(b));

export default async function handler(req,res){
  try{
    const now=new Date(); const qSlot=canonicalSlot(req.query.slot); const slot=qSlot==="auto"?autoSlot(now,TZ):qSlot; const ymd=ymdInTZ(now,TZ);
    const weekend=isWeekendYmd(ymd,TZ); const cap=capsFor(slot,weekend);

    // prefer vbl_full
    const tried=[];
    async function firstHit(keys){ for(const k of keys){ const {raw}=await kvGETraw(k); tried.push({key:k,hit:!!raw}); const arr=J(raw)||(J(J(raw)?.value||"")||[]); if(Array.isArray(arr)&&arr.length) return {key:k,arr}; } return {key:null,arr:[]}; }
    const {key:srcKey,arr:base}=await firstHit([`vbl_full:${ymd}:${slot}`,`vbl:${ymd}:${slot}`,`vb:day:${ymd}:${slot}`,`vb:day:${ymd}:union`,`vb:day:${ymd}:last`]);

    if(!base.length){
      const {raw:tRaw}=await kvGETraw(`tickets:${ymd}:${slot}`); const t=J(tRaw)||{};
      return res.status(200).json({ok:true,slot,ymd,items:[],tickets:t,source:srcKey,note:"empty-slot-feed"});
    }

    const items=base.slice().sort(byConfKick).slice(0,cap).map(it=>{
      // eksplicitno postavi kickoff (UI fallback na slot vreme nestaje)
      const kd=it?.fixture?.date||it?.kickoff_utc||it?.kickoff||null;
      return {...it, kickoff: kd || null};
    });

    const {raw:rawS}=await kvGETraw(`tickets:${ymd}:${slot}`); let tickets=J(rawS)||null;
    if(!tickets){ const {raw:rawD}=await kvGETraw(`tickets:${ymd}`); tickets=J(rawD)||{btts:[],ou25:[],htft:[]}; }

    return res.status(200).json({ok:true,slot,ymd,items,tickets,source:srcKey,policy_cap:cap,slot_cap:cap,debug:{reads:tried}});
  }catch(e){ return res.status(200).json({ok:false,error:String(e?.message||e)}); }
}
