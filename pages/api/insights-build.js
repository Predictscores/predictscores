// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();

/* KV */
function kvBackends(){ const out=[]; const aU=process.env.KV_REST_API_URL, aT=process.env.KV_REST_API_TOKEN; const bU=process.env.UPSTASH_REDIS_REST_URL, bT=process.env.UPSTASH_REDIS_REST_TOKEN; if(aU&&aT) out.push({flavor:"vercel-kv",url:aU.replace(/\/+$/,""),tok:aT}); if(bU&&bT) out.push({flavor:"upstash-redis",url:bU.replace(/\/+$/,""),tok:bT}); return out; }
async function kvGETraw(key,trace){ for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${b.tok}`},cache:"no-store"}); const j=await r.json().catch(()=>null); const raw=typeof j?.result==="string"?j.result:null; trace&&trace.push({get:key,ok:r.ok,flavor:b.flavor,hit:!!raw}); if(!r.ok) continue; return {raw,flavor:b.flavor}; }catch(e){ trace&&trace.push({get:key,ok:false,err:String(e?.message||e)}); } } return {raw:null,flavor:null}; }
async function kvSET(key,val,trace){ const saved=[]; const body=(typeof val==="string")?val:JSON.stringify(val); for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{method:"POST",headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},cache:"no-store",body}); saved.push({flavor:b.flavor,ok:r.ok}); }catch(e){ saved.push({flavor:b.flavor,ok:false,err:String(e?.message||e)}); } } trace&&trace.push({set:key,saved}); return saved; }

const J=s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ=(d,tz)=>new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(d);
const hourInTZ=(d,tz)=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour12:false,hour:"2-digit"}).format(d));
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }

/* AF helpers (fallback za tikete) */
const AF_BASE="https://v3.football.api-sports.io"; const AF_KEY=process.env.API_FOOTBALL_KEY;
async function afOddsByFixture(fid){ if(!AF_KEY) return null; const r=await fetch(`${AF_BASE}/odds?fixture=${fid}`,{headers:{"x-apisports-key":AF_KEY},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return j?.response?.[0]?.bookmakers||[]; }
const conf=x=>Number.isFinite(x?.confidence_pct)?x.confidence_pct:(Number(x?.confidence)||0);
const kstart=x=>{ const k=x?.fixture?.date||x?.fixture_date||x?.kickoff||x?.kickoff_utc||x?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };
const sorter=(a,b)=>(conf(b)-conf(a))||(kstart(a)-kstart(b));
function pickFromBooks(bookmakers,kind){
  let map={};
  for(const b of (bookmakers||[])) for(const bet of (b?.bets||[])){
    const nm=String(bet?.name||"").toLowerCase();
    if(kind==="BTTS"&&nm.includes("both teams to score")){
      for(const v of (bet?.values||[])){ const lbl=String(v?.value||"").toUpperCase(); const odd=Number(v?.odd); if(!Number.isFinite(odd)) continue; const key=/YES/.test(lbl)?"YES":(/NO/.test(lbl)?"NO":null); if(!key) continue; (map[key]||=[]).push(odd); }
    }
    if(kind==="OU25"&&(nm.includes("over/under")||nm.includes("totals"))){
      for(const v of (bet?.values||[])){ const lbl=String(v?.value||"").toUpperCase(); const odd=Number(v?.odd); if(!Number.isFinite(odd)) continue; let key=null; if(lbl.includes("OVER 2.5")) key="OVER 2.5"; else if(lbl.includes("UNDER 2.5")) key="UNDER 2.5"; if(!key) continue; (map[key]||=[]).push(odd); }
    }
    if(kind==="HTFT"&&(nm.includes("ht/ft")||nm.includes("half time/full time"))){
      for(const v of (bet?.values||[])){ const lbl=String(v?.value||"").toUpperCase().replace(/\s+/g,""); const odd=Number(v?.odd); if(!Number.isFinite(odd)) continue; const norm=lbl.replace(/(^|\/)1/g,"$1HOME").replace(/(^|\/)X/g,"$1DRAW").replace(/(^|\/)2/g,"$1AWAY"); (map[norm]||=[]).push(odd); }
    }
  }
  const best=Object.entries(map).map(([k,arr])=>[k,arr&&arr.length?Math.min(...arr):Infinity]).sort((a,b)=>a[1]-b[1])[0];
  if(!best||!isFinite(best[1])) return null; return {pick:best[0],price:best[1]};
}

export default async function handler(req,res){
  try{
    const trace=[]; const now=new Date(); const qSlot=canonicalSlot(req.query.slot); const slot=qSlot==="auto"?autoSlot(now,TZ):qSlot; const ymd=ymdInTZ(now,TZ);
    const keySlot=`tickets:${ymd}:${slot}`; const have=J((await kvGETraw(keySlot,trace)).raw);
    if(have && ((have.btts?.length||0)+(have.ou25?.length||0)+(have.htft?.length||0)>0)){
      const counts={btts:have.btts?.length||0,ou25:have.ou25?.length||0,htft:have.htft?.length||0};
      return res.status(200).json({ok:true,ymd,slot,source:keySlot,tickets_key:keySlot,counts,debug:{trace}});
    }

    const keyDay=`tickets:${ymd}`; const day=J((await kvGETraw(keyDay,trace)).raw);
    if(day && ((day.btts?.length||0)+(day.ou25?.length||0)+(day.htft?.length||0)>0)){
      await kvSET(keySlot,day,trace);
      const counts={btts:day.btts?.length||0,ou25:day.ou25?.length||0,htft:day.htft?.length||0};
      return res.status(200).json({ok:true,ymd,slot,source:keyDay,tickets_key:keySlot,counts,debug:{trace}});
    }

    // Fallback: iz vbl_full slot stavki (≤6 AF poziva)
    const {raw}=await kvGETraw(`vbl_full:${ymd}:${slot}`,trace); const base=J(raw)||[]; const pool=base.slice(0,6);
    const btts=[],ou25=[],htft=[];
    for(const it of pool){
      const fid=it?.fixture_id||it?.fixture?.id||it?.id; if(!fid) continue;
      const books=await afOddsByFixture(fid)||[];
      const p1=pickFromBooks(books,"BTTS"); const p2=pickFromBooks(books,"OU25"); const p3=pickFromBooks(books,"HTFT");
      if(p1) btts.push({...it,market:"BTTS",market_label:"BTTS",selection_label:p1.pick,market_odds:p1.price,confidence_pct:Math.max(55,conf(it))});
      if(p2) ou25.push({...it,market:"O/U 2.5",market_label:"O/U 2.5",selection_label:p2.pick,market_odds:p2.price,confidence_pct:Math.max(55,conf(it))});
      if(p3) htft.push({...it,market:"HT-FT",market_label:"HT-FT",selection_label:p3.pick,market_odds:p3.price,confidence_pct:Math.max(60,conf(it))});
    }
    btts.sort(sorter); ou25.sort(sorter); htft.sort(sorter);
    const groups={btts:btts.slice(0,4),ou25:ou25.slice(0,4),htft:htft.slice(0,4)};
    await kvSET(keySlot,groups,trace); const dayRaw=(await kvGETraw(keyDay,trace)).raw; if(!J(dayRaw)) await kvSET(keyDay,groups,trace);
    const counts={btts:groups.btts.length,ou25:groups.ou25.length,htft:groups.htft.length};
    return res.status(200).json({ok:true,ymd,slot,source:`vbl_full:${ymd}:${slot}`,tickets_key:keySlot,counts,debug:{trace}});
  }catch(e){ return res.status(200).json({ok:false,error:String(e?.message||e)}); }
}
