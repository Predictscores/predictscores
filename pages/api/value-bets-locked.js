export const config = { api: { bodyParser: false } };

// ---- KV
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ---- Osnovni limiti (ostalo iz koda, nema novih ENV)
const VB_LIMIT   = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ---- Realističnost kvota
const MIN_ODDS = 1.50;       // globalno (1X2/BTTS/OU)
const OU_MAX_ODDS = 2.60;    // plafon za OU 2.5 (odbacuje “fantomske” 3.5+)
const BTTS_MAX_ODDS = 2.80;  // plafon za BTTS Yes (odbacuje nerealne 3.2+)

// ---- Prozor / freeze
const WINDOW_HOURS = 72;     // samo naredna 72h
const FREEZE_MIN   = 30;     // ne nudimo <30m do starta

// ---- Bookies pragovi
const TIER3_MIN_BOOKIES = parseInt(process.env.TIER3_MIN_BOOKIES || "3", 10);
const MIN_BOOKIES_1X2_HTFT = 2;
const MIN_BOOKIES_OU_BTTS  = 3;

// ---- SAFE badge prikaz (info)
const SAFE_MIN_PROB = 0.65;
const SAFE_MIN_ODDS = 1.5;
const SAFE_MIN_EV   = -0.005;
const SAFE_MIN_BOOKIES_T12 = 4;
const SAFE_MIN_BOOKIES_T3  = 5;

// ---- Auto rebuild info
const ACTIVE_HOURS = { from: 10, to: 22 }; // CET
const REBUILD_COOLDOWN_MIN = parseInt(process.env.LOCKED_REBUILD_CD || "20", 10);

// ---------- utils
function setNoStore(res){ res.setHeader("Cache-Control","no-store"); }
function ymdTZ(d=new Date()){
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"});
    return fmt.format(d);
  } catch {
    const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),dd=String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hmTZ(d=new Date()){
  try {
    const p = new Intl.DateTimeFormat("en-GB",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false})
      .formatToParts(d).reduce((a,x)=>((a[x.type]=x.value),a),{});
    return { h:+p.hour, m:+p.minute };
  } catch { return { h:d.getHours(), m:d.getMinutes() }; }
}
function unwrapKV(raw){
  let v=raw;
  try {
    if (typeof v==="string"){
      const p=JSON.parse(v);
      v=(p&&typeof p==="object"&&"value" in p)?p.value:p;
    }
    if (typeof v==="string"&&(v.startsWith("{")||v.startsWith("["))) v=JSON.parse(v);
  } catch {}
  return v;
}
async function kvGet(key){
  if(!KV_URL||!KV_TOKEN) return null;
  try{
    const r=await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`,{
      headers:{Authorization:`Bearer ${KV_TOKEN}`}, cache:"no-store",
    });
    if(!r.ok) return null;
    const j=await r.json().catch(()=>null);
    return unwrapKV(j&&typeof j.result!=="undefined"?j.result:null);
  }catch{return null;}
}
async function kvSet(key,value,opts={}){
  if(!KV_URL||!KV_TOKEN) return false;
  try{
    const body={value:typeof value==="string"?value:JSON.stringify(value)};
    if(opts.ex) body.ex=opts.ex;
    if(opts.nx) body.nx=true;
    const r=await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`,{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${KV_TOKEN}`},
      body:JSON.stringify(body),
    });
    return r.ok;
  }catch{return false;}
}

// ---------- heuristike
function isTier3(leagueName="",country=""){
  const s=`${country} ${leagueName}`.toLowerCase();
  return (
    s.includes("3.") || s.includes("third") || s.includes("liga 3") ||
    s.includes("division 2") || s.includes("second division") ||
    s.includes("regional") || s.includes("amateur") || s.includes("cup - ")
  );
}
function isExcludedLeagueOrTeam(p){
  const ln=String(p?.league?.name||"").toLowerCase();
  const hn=String(p?.teams?.home?.name||"").toLowerCase();
  const an=String(p?.teams?.away?.name||"").toLowerCase();
  const bad=/(women|femenin|femmin|ladies|u19|u21|u23|youth|reserve|res\.?)/i;
  return bad.test(ln)||bad.test(hn)||bad.test(an);
}
function isUEFA(leagueName=""){
  return /uefa|champions league|europa|conference/i.test(String(leagueName));
}
function categoryOf(p){
  const m=String(p.market_label||p.market||"");
  if(/btts/i.test(m)) return "BTTS";
  if(/over|under|ou/i.test(m)) return "OU";
  if(/ht-?ft|ht\/ft/i.test(m)) return "HT-FT";
  if(/1x2|match winner/i.test(m)) return "1X2";
  return "OTHER";
}
function meetsBookiesFilter(p){
  const cat=categoryOf(p);
  const n=Number(p?.bookmakers_count||0);
  if(cat==="BTTS"||cat==="OU") return n>=MIN_BOOKIES_OU_BTTS;
  if(cat==="1X2"||cat==="HT-FT") return n>=MIN_BOOKIES_1X2_HTFT;
  return false;
}
function computeSafe(p,tier3){
  const prob=Number(p?.model_prob||0);
  const odds=Number(p?.market_odds||0);
  const ev=Number(p?.ev);
  const bks=Number(p?.bookmakers_count||0);
  const need=tier3?SAFE_MIN_BOOKIES_T3:SAFE_MIN_BOOKIES_T12;
  return (prob>=SAFE_MIN_PROB && odds>=SAFE_MIN_ODDS && Number.isFinite(ev)&&ev>=SAFE_MIN_EV && bks>=need);
}
function kickoffMs(p){
  const s = String(p?.datetime_local?.starting_at?.date_time||"").replace(" ","T");
  const t = Date.parse(s); return Number.isFinite(t)?t:Infinity;
}

// distinct by fixture -> take best by confidence, tie by EV
function distinctByFixture(arr){
  const best=new Map();
  for(const p of arr){
    const fid=p?.fixture_id;
    if(!fid) continue;
    const cur=best.get(fid);
    if(!cur){ best.set(fid,p); continue; }
    const ca=Number(p?.confidence_pct||Math.round((p?.model_prob||0)*100));
    const cb=Number(cur?.confidence_pct||Math.round((cur?.model_prob||0)*100));
    if(ca>cb) best.set(fid,p);
    else if(ca===cb){
      const ea=Number.isFinite(p?.ev)?p.ev:-Infinity;
      const eb=Number.isFinite(cur?.ev)?cur.ev:-Infinity;
      if(ea>eb) best.set(fid,p);
    }
  }
  return [...best.values()];
}

// mala kalibracija conf (ne menja model, samo overlay)
function adjustedConfidence(p){
  let c = Number(p?.confidence_pct || Math.round((p?.model_prob||0)*100));
  const cat = categoryOf(p);
  const odds = Number(p?.market_odds || 0);
  const bks = Number(p?.bookmakers_count || 0);

  // penalizuj nerealno visoke OU/BTTS kvote
  if(cat==="OU"){
    if(odds>2.5) c -= 5;
    if(odds>2.6) c -= 3;
  }
  if(cat==="BTTS"){
    if(odds>2.6) c -= 4;
    if(odds>2.8) c -= 3;
  }
  // slab broj kladionica → penal
  if(bks < 4) c -= 3;
  // safe indikatori → blagi plus
  if(computeSafe(p, isTier3(p?.league?.name||"", p?.league?.country||""))) c += 2;

  c = Math.max(10, Math.min(95, c));
  return c;
}

// ---------- handler
export default async function handler(req,res){
  setNoStore(res);

  const day = ymdTZ();
  const { h } = hmTZ();
  const lastKey = `vb:day:${day}:last`;
  const revKey  = `vb:day:${day}:rev`;
  const cdKey   = `vb:auto:rebuild:cd:${day}`;

  // 1) snapshot
  let arr = unwrapKV(await kvGet(lastKey));
  if(!Array.isArray(arr)) arr=[];

  // 2) auto-rebuild ako prazno i u aktivnim satima
  if(arr.length===0 && h>=ACTIVE_HOURS.from && h<=ACTIVE_HOURS.to){
    const cd=await kvGet(cdKey);
    const now=Date.now();
    const okToRebuild=!cd||(Number(cd?.ts||cd)+REBUILD_COOLDOWN_MIN*60*1000<now);
    if(okToRebuild){
      await kvSet(cdKey,{ts:now},{ex:6*3600});
      try{
        const proto=req.headers["x-forwarded-proto"]||"https";
        const host =req.headers["x-forwarded-host"]||req.headers.host;
        await fetch(`${proto}://${host}/api/cron/rebuild`,{cache:"no-store"});
      }catch{}
      const retry=unwrapKV(await kvGet(lastKey));
      if(Array.isArray(retry)&&retry.length) arr=retry;
    }
    if(!arr.length){
      return res.status(200).json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day,
        source:"ensure-wait",
        meta:{ limit_applied:VB_LIMIT, league_cap:LEAGUE_CAP }
      });
    }
  }

  // 3) filtriranje
  const nowMs = Date.now();
  const maxMs = nowMs + WINDOW_HOURS*3600*1000;

  const byLeagueCount=new Map();
  const prepared=[];

  for(const p0 of arr){
    // kopija da ne diramo original
    const p = { ...p0 };

    // isključenja i prozor/freeze
    if(isExcludedLeagueOrTeam(p)) continue;
    const t=kickoffMs(p);
    if(!(t>nowMs && t<=maxMs)) continue;
    if(t-nowMs < FREEZE_MIN*60*1000) continue;

    // cap po ligi (UEFA izuzetak -> bar 4)
    const leagueName = p?.league?.name || "";
    const leagueKey  = `${p?.league?.country||""}::${leagueName}`;
    const isUefa = isUEFA(leagueName);
    const cap = isUefa ? Math.max(LEAGUE_CAP,4) : LEAGUE_CAP;
    const cur = byLeagueCount.get(leagueKey)||0;
    if(cur>=cap) continue;

    // bookies
    const tier3 = isTier3(leagueName, p?.league?.country||"");
    const nBooks = Number(p?.bookmakers_count||0);
    if(!meetsBookiesFilter(p)) continue;
    if(tier3 && nBooks < TIER3_MIN_BOOKIES) continue;

    // realistične kvote
    const cat = categoryOf(p);
    const odds = Number(p?.market_odds||0);
    if(!(Number.isFinite(odds) && odds>=MIN_ODDS)) continue;
    if(cat==="OU"   && odds>OU_MAX_ODDS) continue;
    if(cat==="BTTS" && odds>BTTS_MAX_ODDS) continue;

    // SAFE badge (info)
    const safe = computeSafe(p,tier3);

    // preferiraj tekstualni “Zašto” ako postoje insights
    const insight = await kvGet(`vb:insight:${p.fixture_id}`).catch(()=>null);
    let explain = p?.explain || {};
    if(insight?.line){
      explain = { ...explain, summary: insight.line };
    }

    // mala kalibracija confidence-a (overlay)
    const adj = adjustedConfidence(p);

    prepared.push({ ...p, safe, explain, confidence_pct: adj });
    byLeagueCount.set(leagueKey, cur+1);
  }

  // 4) distinct: jedna igra po meču
  let final = distinctByFixture(prepared);

  // sort po difoltu: confidence, pa EV, pa kickoff
  final.sort((a,b)=>{
    const ca = Number(a?.confidence_pct||Math.round((a?.model_prob||0)*100));
    const cb = Number(b?.confidence_pct||Math.round((b?.model_prob||0)*100));
    if(cb!==ca) return cb-ca;
    const ea = Number.isFinite(a?.ev)?a.ev:-Infinity;
    const eb = Number.isFinite(b?.ev)?b.ev:-Infinity;
    if(eb!==ea) return eb-ea;
    return kickoffMs(a)-kickoffMs(b);
  });

  const revRaw = unwrapKV(await kvGet(revKey));
  let rev=0; try { rev = parseInt(String(revRaw?.value??revRaw??"0"),10)||0; } catch {}

  return res.status(200).json({
    value_bets: final.slice(0, VB_LIMIT),
    built_at: new Date().toISOString(),
    day,
    source: "locked-cache",
    meta: {
      limit_applied: VB_LIMIT,
      league_cap: LEAGUE_CAP,
      floats_enabled: !!process.env.SMART45_FLOAT_ENABLED,
      safe_enabled: true,
      safe_min_prob: SAFE_MIN_PROB,
      safe_min_odds: SAFE_MIN_ODDS,
      safe_min_ev: SAFE_MIN_EV,
      safe_min_bookies_t12: SAFE_MIN_BOOKIES_T12,
      safe_min_bookies_t3:  SAFE_MIN_BOOKIES_T3,
      window_hours: WINDOW_HOURS,
      freeze_min: FREEZE_MIN,
      min_odds: MIN_ODDS,
      ou_max_odds: OU_MAX_ODDS,
      btts_max_odds: BTTS_MAX_ODDS,
      rev
    },
  });
}
