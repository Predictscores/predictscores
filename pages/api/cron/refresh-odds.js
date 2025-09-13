// pages/api/cron/refresh-odds.js
export const config = { api: { bodyParser: false } };

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();

/* KV */
function kvBackends(){
  const out=[]; const aU=process.env.KV_REST_API_URL, aT=process.env.KV_REST_API_TOKEN;
  const bU=process.env.UPSTASH_REDIS_REST_URL, bT=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(aU&&aT) out.push({flavor:"vercel-kv",url:aU.replace(/\/+$/,""),tok:aT});
  if(bU&&bT) out.push({flavor:"upstash-redis",url:bU.replace(/\/+$/,""),tok:bT});
  return out;
}
async function kvGETraw(key){ for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${b.tok}`},cache:"no-store"}); if(!r.ok) continue; const j=await r.json().catch(()=>null); const raw=typeof j?.result==="string"?j.result:null; if(raw) return {raw,flavor:b.flavor}; }catch{} } return {raw:null,flavor:null}; }
async function kvSET(key,val){ const saves=[]; const body=(typeof val==="string")?val:JSON.stringify(val); for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{method:"POST",headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},cache:"no-store",body}); saves.push({flavor:b.flavor,ok:r.ok}); }catch(e){ saves.push({flavor:b.flavor,ok:false,error:String(e?.message||e)}); } } return saves; }
const J=s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ=(d,tz)=>new Intl.DateTimeFormat("en-CA",{timeZone:tz}).format(d);
const hourInTZ=(d,tz)=>Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour12:false,hour:"2-digit"}).format(d));
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }

/* API-Football odds (trusted only) */
const AF_BASE="https://v3.football.api-sports.io";
const AF_KEY =process.env.API_FOOTBALL_KEY;
const TRUSTED=new Set(["Pinnacle","bet365","Bet365","William Hill","WilliamHill","Bwin","Unibet","1xBet","1XBET","Marathon","10Bet","10bet","Betano","Betfair","Betway","888sport","DraftKings","FanDuel"]);
async function afOddsByFixture(fid){ if(!AF_KEY) return null; const r=await fetch(`${AF_BASE}/odds?fixture=${fid}`,{headers:{"x-apisports-key":AF_KEY},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return j?.response?.[0]?.bookmakers||[]; }
function best1x2(bookmakers){
  let booksCount=0; let best={H:null,D:null,A:null};
  for(const b of (bookmakers||[])){
    const name=String(b?.name||"").trim(); if(!TRUSTED.has(name)) continue;
    for(const bet of (b?.bets||[])){
      const nm=String(bet?.name||"").toLowerCase();
      if(!(nm.includes("match winner")||nm.includes("1x2")||nm.includes("fulltime")||nm.includes("full time"))) continue;
      booksCount++;
      for(const v of (bet?.values||[])){
        const lbl=String(v?.value||"").toUpperCase().replace(/\s+/g,""); const odd=Number(v?.odd); if(!Number.isFinite(odd)) continue;
        if(/(HOME|^1$)/.test(lbl)) best.H=Math.max(best.H||0,odd);
        else if(/(DRAW|^X$)/.test(lbl)) best.D=Math.max(best.D||0,odd);
        else if(/(AWAY|^2$)/.test(lbl)) best.A=Math.max(best.A||0,odd);
      }
    }
  }
  return {best,booksCount};
}
function withPick(it,best){
  if(it?.selection_label) return it;
  const cand=[["Home",best.H],["Draw",best.D],["Away",best.A]].filter(([,p])=>Number.isFinite(p)&&p>0);
  if(!cand.length) return it;
  const fav=cand.slice().sort((a,b)=>a[1]-b[1])[0];
  return {...it,selection_label:fav[0],pick:fav[0],pick_code:fav[0].startsWith("H")?"1":fav[0].startsWith("D")?"X":"2"};
}

export default async function handler(req,res){
  try{
    const now=new Date(); const qSlot=canonicalSlot(req.query.slot); const slot=qSlot==="auto"?autoSlot(now,TZ):qSlot; const ymd=ymdInTZ(now,TZ);
    const {raw}=await kvGETraw(`vbl_full:${ymd}:${slot}`); const list=J(raw)||[];
    if(!list.length) return res.status(200).json({ok:true,ymd,slot,inspected:0,filtered:0,targeted:0,touched:0,source:"vbl_full:empty",odds_api:[],oa_summary:{matched:0,saved:0,calls:0}});
    let touched=0,targeted=0; const updated=[];
    for(const it of list){
      const fid=it?.fixture_id||it?.fixture?.id||it?.id; if(!fid){ updated.push(it); continue; }
      targeted++;
      const books=await afOddsByFixture(fid); const {best,booksCount}=best1x2(books);
      const withSel=withPick(it,best);
      let price=null;
      if(withSel?.selection_label){
        if(/^home/i.test(withSel.selection_label)) price=best.H;
        else if(/^draw/i.test(withSel.selection_label)) price=best.D;
        else if(/^away/i.test(withSel.selection_label)) price=best.A;
      }
      if(Number.isFinite(price)&&price>1){ updated.push({...withSel,odds:{price,books_count:booksCount}}); touched++; }
      else { updated.push({...withSel,odds:{price:withSel?.odds?.price??null,books_count:booksCount||(withSel?.odds?.books_count??0)}}); }
    }
    const saves=[]; saves.push(...await kvSET(`vbl_full:${ymd}:${slot}`,updated)); saves.push(...await kvSET(`vbl:${ymd}:${slot}`,updated));
    return res.status(200).json({ok:true,ymd,slot,inspected:list.length,filtered:0,targeted,touched,source:`vbl_full:${ymd}:${slot}`,saves});
  }catch(e){ return res.status(200).json({ok:false,error:String(e?.message||e)}); }
}
