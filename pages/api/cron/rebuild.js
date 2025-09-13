// pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();

/* KV */
function kvBackends(){ const out=[]; const aU=process.env.KV_REST_API_URL, aT=process.env.KV_REST_API_TOKEN; const bU=process.env.UPSTASH_REDIS_REST_URL, bT=process.env.UPSTASH_REDIS_REST_TOKEN; if(aU&&aT) out.push({flavor:"vercel-kv",url:aU.replace(/\/+$/,""),tok:aT}); if(bU&&bT) out.push({flavor:"upstash-redis",url:bU.replace(/\/+$/,""),tok:bT}); return out; }
async function kvGETraw(key){ for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${b.tok}`},cache:"no-store"}); if(!r.ok) continue; const j=await r.json().catch(()=>null); const val=typeof j?.result==="string"?j.result:null; if(val) return {raw:val,flavor:b.flavor}; }catch{} } return {raw:null,flavor:null}; }
async function kvSET(key,val){ const saves=[]; const body=(typeof val==="string")?val:JSON.stringify(val); for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{method:"POST",headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},cache:"no-store",body}); saves.push({flavor:b.flavor,ok:r.ok}); }catch(e){ saves.push({flavor:b.flavor,ok:false,error:String(e?.message||e)}); } } return saves; }

const J=s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ=(d,tz)=>new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(d);
const hourInTZ=(d,tz)=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour12:false,hour:"2-digit"}).format(d));
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }

const confidence=it=>Number.isFinite(it?.confidence_pct)?it.confidence_pct:(Number(it?.confidence)||0);
const kickoffFromMeta=it=>{ const k=it?.fixture?.date||it?.fixture_date||it?.kickoff||it?.kickoff_utc||it?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d:null; };
const byConfKick=(a,b)=>(confidence(b)-confidence(a))||((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0));

function isYouthLeague(name,country){
  const n=String(name||""); if(/\bU(?:\s|-)?(?:15|16|17|18|19|20|21|22|23)\b/i.test(n)) return true;
  if(/\bYouth|Reserves?|Primavera|U-\d{2}\b/i.test(n)) return true;
  if(/U\d\d/.test(n)) return true;
  return false;
}
function isUefa(name,country){
  const n=String(name||""); const c=String(country||"");
  return /UEFA|Champions League|Europa League|Conference League|European Championship|Euro Qual/i.test(n) || /Europe/i.test(c);
}
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

const hasAnyTickets = obj => !!(obj && ((obj.btts?.length||0)+(obj.ou25?.length||0)+(obj.htft?.length||0)>0));

export default async function handler(req,res){
  try{
    const now=new Date(); const qSlot=canonicalSlot(req.query.slot); const slot=qSlot==="auto"?autoSlot(now,TZ):qSlot; const ymd=ymdInTZ(now,TZ);
    const weekend=isWeekendYmd(ymd,TZ); const cap=capsFor(slot,weekend);

    // baza za dan
    const tried=[];
    async function firstHit(keys){ for(const k of keys){ const r=await kvGETraw(k); tried.push({key:k,hit:!!r.raw}); const arr=J(r.raw)||(J(J(r.raw)?.value||"")||[]); if(Array.isArray(arr)&&arr.length) return {key:k,arr}; } return {key:null,arr:[]}; }
    const {key:srcKey,arr:base}=await firstHit([`vb:day:${ymd}:${slot}`,`vb:day:${ymd}:union`,`vb:day:${ymd}:last`]);

    // filter: slot prozor + ukloni youth/rezervne; max 2 po ligi (UEFA do 6)
    const only=base.filter(it=>{
      const lg=it?.league||{}; if(isYouthLeague(lg.name,lg.country)) return false;
      const kd=kickoffFromMeta(it); if(!kd) return false;
      const ky=ymdInTZ(kd,TZ); if(ky!==ymd) return false;
      const h=hourInTZ(kd,TZ);
      return slot==="late"?(h<10):slot==="am"?(h>=10&&h<15):(h>=15);
    }).sort(byConfKick);

    const perLeague=new Map(); const kept=[];
    for(const it of only){
      const lg=it?.league||{}; const key=String(lg.id||lg.name||"?");
      const limit=isUefa(lg.name,lg.country)?6:2;
      const cur=perLeague.get(key)||0; if(cur>=limit) continue;
      perLeague.set(key,cur+1); kept.push(it);
      if(kept.length>=cap) break;
    }

    const saves=[]; saves.push(...await kvSET(`vbl:${ymd}:${slot}`,kept)); saves.push(...await kvSET(`vbl_full:${ymd}:${slot}`,kept));

    // zamrzni tikete — **ne prepisuj slot praznim!**
    const slotKey = `tickets:${ymd}:${slot}`;
    const slotNow = J((await kvGETraw(slotKey)).raw);
    let ticketAction = "noop";
    if (!hasAnyTickets(slotNow)) {
      const dayKey = `tickets:${ymd}`;
      const dayObj = J((await kvGETraw(dayKey)).raw);
      if (hasAnyTickets(dayObj)) {
        await kvSET(slotKey, dayObj);
        ticketAction = "copied-day-to-slot";
      } else {
        ticketAction = "no-day-tickets";
      }
    } else {
      ticketAction = "kept-existing-slot";
    }

    return res.status(200).json({
      ok:true, ymd, slot,
      counts:{ base: base.length, after_filters: only.length, kept: kept.length },
      source: srcKey,
      diag:{ reads: tried, writes: { saves }, tickets: { action: ticketAction } }
    });
  }catch(e){ return res.status(200).json({ok:false,error:String(e?.message||e)}); }
}
