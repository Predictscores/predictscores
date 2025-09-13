// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();

/* KV (Vercel KV + Upstash) */
function kvBackends(){ const out=[]; const aU=process.env.KV_REST_API_URL, aT=process.env.KV_REST_API_TOKEN; const bU=process.env.UPSTASH_REDIS_REST_URL, bT=process.env.UPSTASH_REDIS_REST_TOKEN; if(aU&&aT) out.push({flavor:"vercel-kv",url:aU.replace(/\/+$/,""),tok:aT}); if(bU&&bT) out.push({flavor:"upstash-redis",url:bU.replace(/\/+$/,""),tok:bT}); return out; }
async function kvGETraw(key){ for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${b.tok}`},cache:"no-store"}); if(!r.ok) continue; const j=await r.json().catch(()=>null); const raw=typeof j?.result==="string"?j.result:null; if(raw) return {raw,flavor:b.flavor}; }catch{} } return {raw:null,flavor:null}; }
async function kvSET(key,val){ const saved=[]; const body=(typeof val==="string")?val:JSON.stringify(val); for(const b of kvBackends()){ try{ const r=await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{method:"POST",headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},cache:"no-store",body}); saved.push({flavor:b.flavor,ok:r.ok}); }catch(e){ saved.push({flavor:b.flavor,ok:false,err:String(e?.message||e)}); } } return saved; }
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

const MIN_ODDS = Number(process.env.MIN_ODDS_1X2 || 1.5);

/* —— scoring (najjači predlozi) —— */
const conf01 = it => {
  const c = Number.isFinite(it?.confidence_pct) ? it.confidence_pct : Number(it?.confidence)||0;
  return Math.max(0, Math.min(100, c)) / 100;
};
const evPart = it => {
  const mp = Number(it?.model_prob); const price = Number(it?.odds?.price);
  if (Number.isFinite(mp) && Number.isFinite(price) && price>0) {
    const implied = 1/price;
    return mp - implied; // može biti negativno/pozitivno
  }
  return 0;
};
const oddsQual = it => {
  const p = Number(it?.odds?.price);
  if (!Number.isFinite(p)) return 0;
  if (p < 1.5) return -1;
  if (p < 1.7) return 0.1;
  if (p < 2.2) return 0.5;
  if (p < 3.0) return 0.4;
  return 0.2;
};
const booksPart = it => Math.min(1, (Number(it?.odds?.books_count)||0) / 3);
const tierBoost = it => {
  const t = Number(it?.league?.tier || it?.tier || 3);
  if (t === 1) return 1;
  if (t === 2) return 0.5;
  return 0;
};
const score = it => 0.30*conf01(it) + 0.35*evPart(it) + 0.15*oddsQual(it) + 0.10*booksPart(it) + 0.10*tierBoost(it);

/* kickoff helpers */
const kickoffMs=it=>{ const k=it?.fixture?.date||it?.fixture_date||it?.kickoff||it?.kickoff_utc||it?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };
const kickoffISO=it=>{ const k=it?.fixture?.date||it?.kickoff_utc||it?.kickoff||null; return k||null; };

/* AF specials for tickets */
const AF_BASE="https://v3.football.api-sports.io"; const AF_KEY=process.env.API_FOOTBALL_KEY;
async function afOddsByFixture(fid){ if(!AF_KEY) return null; const r=await fetch(`${AF_BASE}/odds?fixture=${fid}`,{headers:{"x-apisports-key":AF_KEY},cache:"no-store"}); if(!r.ok) return null; const j=await r.json().catch(()=>null); return j?.response?.[0]?.bookmakers||[]; }
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

/* slot half windows (u minutama od ponoći u Belgradu) */
function slotBounds(slot){
  if(slot==="late") return {start:0, end:599};        // 00:00–09:59 => 0..599
  if(slot==="am")   return {start:600, end:899};      // 10:00–14:59 => 600..899
  return {start:900, end:1439};                       // 15:00–23:59 => 900..1439
}
function todMinutes(date, tz){
  const hh = Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",minute:"2-digit",hour12:false}).format(date).slice(0,2));
  const mm = Number(new Intl.DateTimeFormat("en-GB",{timeZone:tz,minute:"2-digit"}).format(date));
  return hh*60+mm;
}
function inHalf(it, tz, slot){
  const k = new Date(kickoffMs(it)); if(!k||!Number.isFinite(k.getTime())) return "h1";
  const {start,end}=slotBounds(slot);
  const m = todMinutes(k, tz);
  const mid = Math.floor((start+end)/2);
  return (m<=mid) ? "h1" : "h2";
}

export default async function handler(req,res){
  try{
    const now=new Date(); const qSlot=canonicalSlot(req.query.slot); const slot=qSlot==="auto"?autoSlot(now,TZ):qSlot; const ymd=ymdInTZ(now,TZ);
    const weekend=isWeekendYmd(ymd,TZ); const cap=capsFor(slot,weekend);

    // prefer vbl_full (NIJE cap-ovan)
    const tried=[];
    async function firstHit(keys){ for(const k of keys){ const {raw}=await kvGETraw(k); tried.push({key:k,hit:!!raw}); const arr=J(raw)||(J(J(raw)?.value||"")||[]); if(Array.isArray(arr)&&arr.length) return {key:k,arr}; } return {key:null,arr:[]}; }
    const {key:srcKey,arr:base0}=await firstHit([`vbl_full:${ymd}:${slot}`,`vbl:${ymd}:${slot}`,`vb:day:${ymd}:${slot}`,`vb:day:${ymd}:union`,`vb:day:${ymd}:last`]);

    if(!base0.length){
      const {raw:tRaw}=await kvGETraw(`tickets:${ymd}:${slot}`); const t=J(tRaw)||{};
      return res.status(200).json({ok:true,slot,ymd,items:[],tickets:t,source:srcKey,note:"empty-slot-feed"});
    }

    // izbaci poznate kvote < 1.5 (null ostaje)
    const base = base0.filter(it => {
      const p = Number(it?.odds?.price);
      return !(Number.isFinite(p) && p < MIN_ODDS);
    });

    // rangiraj sve po score-u (najjači)
    const ranked = base.slice().sort((a,b)=>score(b)-score(a));

    // raspodela po polovinama slota (proporcionalno gustini, Hamilton)
    const h1 = [], h2 = [];
    for(const it of ranked){ (inHalf(it, TZ, slot)==="h1"?h1:h2).push(it); }
    const n1=h1.length, n2=h2.length, N=n1+n2||1;
    let q1 = Math.floor(cap * (n1 / N));
    let q2 = Math.floor(cap * (n2 / N));
    const used = q1+q2; let left = cap - used;
    const r1 = (cap * (n1/N)) - q1, r2 = (cap * (n2/N)) - q2;
    const order = r1===r2 ? (n1>=n2?["h1","h2"]:["h2","h1"]) : (r1>r2?["h1","h2"]:["h2","h1"]);
    if(n1>0 && q1===0) { q1=1; left--; }
    if(n2>0 && q2===0) { q2=1; left--; }
    for(const t of order){ if(left<=0) break; if(t==="h1" && q1<n1){ q1++; left--; } else if(t==="h2" && q2<n2){ q2++; left--; } }
    // pick iz svake polovine po kvoti, ostatak popuniti najboljima
    const pickSet = new Set();
    const takeH1 = h1.slice(0,q1), takeH2 = h2.slice(0,q2);
    for(const it of [...takeH1,...takeH2]) pickSet.add(it);
    let items = [...pickSet];
    if(items.length<cap){
      for(const it of ranked){ if(items.length>=cap) break; if(!pickSet.has(it)) { items.push(it); pickSet.add(it); } }
    }
    // kickoff polje za UI
    items = items.map(it => ({...it, kickoff: kickoffISO(it)}));

    // Tiketi: zamrznuti po slotu; ako prazno → Fallback iz NAJJAČIH (ne po vremenu)
    let tickets = J((await kvGETraw(`tickets:${ymd}:${slot}`)).raw);
    if(!hasAnyTickets(tickets)){
      const dayT = J((await kvGETraw(`tickets:${ymd}`)).raw);
      if(hasAnyTickets(dayT)){
        tickets = dayT;
        await kvSET(`tickets:${ymd}:${slot}`, tickets);
      }else{
        // Fallback: uzmi top-kand. kroz ceo slot po score-u; ograniči AF pozive
        const pool = ranked.slice(0, 12); // jaka baza
        const btts=[], ou25=[], htft=[];
        let calls=0, MAX_CALLS=8;
        for(const it of pool){
          if(calls>=MAX_CALLS) break;
          const fid = it?.fixture_id || it?.fixture?.id || it?.id; if(!fid) continue;
          const books = await afOddsByFixture(fid) || []; calls++;
          const p1=pickFromBooks(books,"BTTS"); const p2=pickFromBooks(books,"OU25"); const p3=pickFromBooks(books,"HTFT");
          if(p1 && btts.length<4) btts.push({...it, market:"BTTS", market_label:"BTTS", selection_label:p1.pick, market_odds:p1.price, confidence_pct:Math.max(55, it?.confidence_pct||50)});
          if(p2 && ou25.length<4) ou25.push({...it, market:"O/U 2.5", market_label:"O/U 2.5", selection_label:p2.pick, market_odds:p2.price, confidence_pct:Math.max(55, it?.confidence_pct||50)});
          if(p3 && htft.length<4) htft.push({...it, market:"HT-FT", market_label:"HT-FT", selection_label:p3.pick, market_odds:p3.price, confidence_pct:Math.max(60, it?.confidence_pct||50)});
          if(btts.length>=4 && ou25.length>=4 && htft.length>=4) break;
        }
        tickets = { btts, ou25, htft };
        await kvSET(`tickets:${ymd}:${slot}`, tickets);
      }
    }

    return res.status(200).json({
      ok:true, slot, ymd,
      items, tickets, source:srcKey,
      policy_cap:cap, slot_cap:cap, min_odds:MIN_ODDS
    });
  }catch(e){ return res.status(200).json({ok:false,error:String(e?.message||e)}); }
}
