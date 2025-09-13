// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();

/* KV (Vercel KV + Upstash) */
function kvBackends(){ const out=[]; const aU=process.env.KV_REST_API_URL, aT=process.env.KV_REST_API_TOKEN; const bU=process.env.UPSTASH_REDIS_REST_URL, bT=process.env.UPSTASH_REDIS_REST_TOKEN; if(aU&&aT) out.push({flavor:"vercel-kv",url:aU.replace(/\/+$/,""),tok:aT}); if(bU&&bT) out.push({flavor:"upstash-redis",url:bU.replace(/\/+$/,""),tok:bT}); return out; }
async function kvGETraw(key,trace){ for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${b.tok}`},cache:"no-store"}); const j=await r.json().catch(()=>null); const raw=typeof j?.result==="string"?j.result:null; trace&&trace.push({get:key,ok:r.ok,flavor:b.flavor,hit:!!raw}); if(raw) return {raw,flavor:b.flavor}; }catch(e){ trace&&trace.push({get:key,ok:false,err:String(e?.message||e)}); } } return {raw:null,flavor:null}; }
async function kvSET(key,val,trace){ const saved=[]; const body=(typeof val==="string")?val:JSON.stringify(val); for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{method:"POST",headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},cache:"no-store",body}); saved.push({flavor:b.flavor,ok:r.ok}); }catch(e){ saved.push({flavor:b.flavor,ok:false,err:String(e?.message||e)}); } } trace&&trace.push({set:key,saved}); return saved; }

const J=s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };

const ymdInTZ=(d,tz)=>new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(d);
const hourInTZ=(d,tz)=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour12:false,hour:"2-digit"}).format(d));
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }

/* kapovi po slotu; bez dodatnih ENV-ova */
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

/* rangiranje */
const MIN_ODDS = Number(process.env.MIN_ODDS_1X2 || 1.5);  // server-side prag
const confidence=it=>Number.isFinite(it?.confidence_pct)?it.confidence_pct:(Number(it?.confidence)||0);
const kickoffTs=it=>{ const k=it?.fixture?.date||it?.fixture_date||it?.kickoff||it?.kickoff_utc||it?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };
const byConfKick=(a,b)=>(confidence(b)-confidence(a))||(kickoffTs(a)-kickoffTs(b));

/* AF fallback za specijale (isto kao u insights-build) */
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
const hasAnyTickets=obj=>!!(obj && ((obj.btts?.length||0)+(obj.ou25?.length||0)+(obj.htft?.length||0)>0));

export default async function handler(req,res){
  try{
    const trace=[]; const now=new Date(); const qSlot=canonicalSlot(req.query.slot); const slot=qSlot==="auto"?autoSlot(now,TZ):qSlot; const ymd=ymdInTZ(now,TZ);
    const weekend=isWeekendYmd(ymd,TZ); const cap=capsFor(slot,weekend);

    // feed (prefer vbl_full)
    const tried=[];
    async function firstHit(keys){ for(const k of keys){ const {raw}=await kvGETraw(k,trace); tried.push({key:k,hit:!!raw}); const arr=J(raw)||(J(J(raw)?.value||"")||[]); if(Array.isArray(arr)&&arr.length) return {key:k,arr}; } return {key:null,arr:[]}; }
    const {key:srcKey,arr:base}=await firstHit([`vbl_full:${ymd}:${slot}`,`vbl:${ymd}:${slot}`,`vb:day:${ymd}:${slot}`,`vb:day:${ymd}:union`,`vb:day:${ymd}:last`]);

    if(!base.length){
      const {raw:tRaw}=await kvGETraw(`tickets:${ymd}:${slot}`,trace); const t=J(tRaw)||{};
      return res.status(200).json({ok:true,slot,ymd,items:[],tickets:t,source:srcKey,note:"empty-slot-feed",debug:{reads:tried,trace}});
    }

    // filter: odstrani poznate kvote < 1.5; null ostaje
    const filtered = base.filter(it => {
      const p = Number(it?.odds?.price);
      return !(Number.isFinite(p) && p < MIN_ODDS);
    });

    // sortiraj i ograniči; eksplicitno postavi kickoff za UI
    const items=filtered.slice().sort(byConfKick).slice(0,cap).map(it=>{
      const kd=it?.fixture?.date||it?.kickoff_utc||it?.kickoff||null;
      return {...it, kickoff: kd || null};
    });

    // Tiketi: slot → day → Fallback iz slot stavki (≤6 AF poziva), pa save u slot
    const slotKey=`tickets:${ymd}:${slot}`;
    let tickets = J((await kvGETraw(slotKey,trace)).raw);
    if(!hasAnyTickets(tickets)){
      let day = J((await kvGETraw(`tickets:${ymd}`,trace)).raw);
      if(hasAnyTickets(day)){
        tickets = day;
        await kvSET(slotKey, tickets, trace);
      }else{
        // Fallback: napravi 3 grupe iz prvih 6 stavki
        const pool = items.slice(0,6);
        const btts=[], ou25=[], htft=[];
        for(const it of pool){
          const fid = it?.fixture_id || it?.fixture?.id || it?.id; if(!fid) continue;
          const books = await afOddsByFixture(fid) || [];
          const p1=pickFromBooks(books,"BTTS"); const p2=pickFromBooks(books,"OU25"); const p3=pickFromBooks(books,"HTFT");
          if(p1) btts.push({...it, market:"BTTS", market_label:"BTTS", selection_label:p1.pick, market_odds:p1.price, confidence_pct:Math.max(55,conf(it))});
          if(p2) ou25.push({...it, market:"O/U 2.5", market_label:"O/U 2.5", selection_label:p2.pick, market_odds:p2.price, confidence_pct:Math.max(55,conf(it))});
          if(p3) htft.push({...it, market:"HT-FT", market_label:"HT-FT", selection_label:p3.pick, market_odds:p3.price, confidence_pct:Math.max(60,conf(it))});
        }
        btts.sort(sorter); ou25.sort(sorter); htft.sort(sorter);
        tickets = { btts: btts.slice(0,4), ou25: ou25.slice(0,4), htft: htft.slice(0,4) };
        await kvSET(slotKey, tickets, trace);
      }
    }

    return res.status(200).json({
      ok:true, slot, ymd,
      items, tickets, source:srcKey,
      policy_cap:cap, slot_cap:cap, min_odds:MIN_ODDS,
      debug:{reads:tried, trace}
    });
  }catch(e){ return res.status(200).json({ok:false,error:String(e?.message||e)}); }
}
