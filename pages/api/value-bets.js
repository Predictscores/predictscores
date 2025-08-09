// FILE: pages/api/value-bets.js
//
// Dnevni TOP value betovi (fudbal) – štedljiv pipeline (≤12 TheOdds poziva/dan)
// - SportMonks fixtures (cache 6h)
// - The Odds: /sports/upcoming/odds -> filtriramo Soccer (cache 2h)
// - Ako nema kvota → FALLBACK (mekši prag da ne bude prazno)
// - Vraća do 10 predloga, dopunjava slabijima kad treba
//
// Prikaz vremena: Europe/Belgrade

export const config = { api: { bodyParser: false } };

const SPORTMONKS_KEY = process.env.SPORTMONKS_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_MAX_CALLS_PER_DAY = Number(process.env.ODDS_MAX_CALLS_PER_DAY || "12");
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Mekši pragovi da uvek imamo sadržaj
const FALLBACK_STRICT_MIN = Number(process.env.FALLBACK_STRICT_MIN || "0.48");
const FALLBACK_WEAK_MIN   = Number(process.env.FALLBACK_WEAK_MIN   || "0.40");
const MIN_EDGE_STRICT     = Number(process.env.MIN_EDGE_STRICT     || "0.05");
const MIN_EDGE_WEAK       = Number(process.env.MIN_EDGE_WEAK       || "0.03");
const MIN_ODDS            = Number(process.env.MIN_ODDS             || "1.30");

let _fixturesCache = { date: null, data: null, fetchedAt: 0 };
let _oddsCache = {
  dayKey: null,
  data: null,
  fetchedAt: 0,
  lastCallTimestamps: [],
  previousData: null,
};

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function toNumber(x, def=0){ const n=Number(x); return Number.isFinite(n)?n:def; }

function todayYMD(tz="UTC"){
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const [{value:y},, {value:m},, {value:dd}] = fmt.formatToParts(d);
  return `${y}-${m}-${dd}`;
}
function formatBelgradeDateTime(isoUtc){
  try{
    if(!isoUtc) return "";
    const d = new Date(isoUtc.endsWith("Z")? isoUtc : isoUtc+"Z");
    const fmtDate = new Intl.DateTimeFormat('en-CA',{timeZone:TZ_DISPLAY,year:'numeric',month:'2-digit',day:'2-digit'});
    const fmtTime = new Intl.DateTimeFormat('en-GB',{timeZone:TZ_DISPLAY,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const [{value:y},, {value:m},, {value:da}] = fmtDate.formatToParts(d);
    return `${y}-${m}-${da} ${fmtTime.format(d)}`;
  }catch{ return isoUtc }
}
function normalizeTeamName(name=""){
  return String(name||"").toLowerCase()
    .replace(/football club|fc|cf|afc|club|sc|ac|calcio|fk|kk|bk|u19|u21|women|ladies/gi,"")
    .replace(/[^a-z0-9]+/gi," ").trim().replace(/\s+/g," ");
}
function impliedFromBestOdds(best){
  const invH = best.home?1/best.home:0, invD = best.draw?1/best.draw:0, invA = best.away?1/best.away:0;
  const s = invH+invD+invA; if(s<=0) return {home:0,draw:0,away:0,overround:0};
  return {home:invH/s,draw:invD/s,away:invA/s,overround:s};
}
function pickBestOddsForH2H(bookmakers=[]){
  let best={home:0,draw:0,away:0}, count=0;
  for(const b of bookmakers||[]){
    const m=(b.markets||[]).find(x=>x.key==='h2h'); if(!m) continue;
    const out=m.outcomes||[];
    // razni bookovi imaju različite nazive – probajmo više opcija
    const by = (label, alt=[]) => out.find(o => [label, ...alt].includes((o.name||"").toLowerCase()));
    const home = by('home', ['home team','1']);
    const away = by('away', ['away team','2']);
    const draw = by('draw', ['tie','x']);
    if(home?.price) best.home=Math.max(best.home,home.price);
    if(away?.price) best.away=Math.max(best.away,away.price);
    if(draw?.price) best.draw=Math.max(best.draw,draw.price);
    count++;
  }
  return {best,bookmakerCount:count};
}
function baseModel1X2Prob(fix){
  // ultra-lagan model (stabilan kad nema standings)
  const homeAdv = 0.12; // malo jači home bias da lakše pređe fallback
  let pH=0.45, pA=0.30, pD=0.25;
  pH += homeAdv; pA -= homeAdv/2; pD -= homeAdv/2;
  const s = pH+pD+pA;
  return { home:pH/s, draw:pD/s, away:pA/s };
}
function scoreFromEdge(edge,movement=0,bookies=0,hoursToKO=24){
  const e=clamp(edge,-1,1), m=clamp(movement,-1,1), b=clamp(bookies/10,0,1);
  const t = hoursToKO>=6?0.6:hoursToKO>=3?0.5:0.3;
  const score = 0.55*e + 0.20*m + 0.15*b + 0.10*(1-Math.abs(t-0.45));
  return clamp((score+1)/2*100,0,100);
}
function hoursUntil(isoUTC){
  try{ const t=new Date(isoUTC.endsWith("Z")?isoUTC:isoUTC+"Z").getTime(); return (t-Date.now())/3600000; }
  catch{ return 999; }
}
function confidenceBucket(p){
  if(p>=0.90) return "TOP";
  if(p>=0.75) return "High";
  if(p>=0.50) return "Moderate";
  return "Low";
}
function currentDayKey(){ return todayYMD(TZ_DISPLAY); }

// ---- SportMonks fixtures (za ceo dan) ----
async function fetchFixturesForDate(dateYMD){
  try{
    if(_fixturesCache.date===dateYMD && _fixturesCache.data && Date.now()-_fixturesCache.fetchedAt<6*3600_000){
      return _fixturesCache.data;
    }
    // date endpoint je OK; ‘between’ varijanta nije neophodna
    const url=`https://soccer.sportmonks.com/api/v2.0/fixtures/date/${dateYMD}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(SPORTMONKS_KEY)}&tz=UTC`;
    const res=await fetch(url);
    if(!res.ok) throw new Error(`SportMonks HTTP ${res.status}`);
    const json=await res.json();
    _fixturesCache={date:dateYMD,data:json,fetchedAt:Date.now()};
    return json;
  }catch(e){ console.error("SportMonks",e?.message||e); return {data:[]} }
}

// ---- The Odds: jedan “upcoming” snapshot (2h cache) ----
async function fetchOddsSnapshotGuarded(){
  const dayKey=currentDayKey();
  if(_oddsCache.dayKey!==dayKey){ _oddsCache.dayKey=dayKey; _oddsCache.lastCallTimestamps=[]; }
  if(_oddsCache.data && Date.now()-_oddsCache.fetchedAt<2*3600_000){
    return {data:_oddsCache.data, previous:_oddsCache.previousData};
  }
  if(_oddsCache.lastCallTimestamps.length>=ODDS_MAX_CALLS_PER_DAY){
    return {data:_oddsCache.data, previous:_oddsCache.previousData};
  }
  if(!ODDS_API_KEY){ return {data:null, previous:_oddsCache.previousData}; }

  try{
    // Jedan poziv: upcoming/odds (filtriraćemo samo Soccer)
    const params=new URLSearchParams({
      regions:"eu", markets:"h2h", oddsFormat:"decimal", apiKey:ODDS_API_KEY
    });
    const url=`https://api.the-odds-api.com/v4/sports/upcoming/odds?${params.toString()}`;
    const res=await fetch(url,{headers:{accept:'application/json'}});
    if(!res.ok){ console.warn("TheOdds HTTP",res.status); return {data:null, previous:_oddsCache.previousData}; }
    const json=await res.json();
    const onlySoccer = Array.isArray(json) ? json.filter(evt => (evt.sport_title||"").toLowerCase().includes("soccer")) : null;

    _oddsCache.lastCallTimestamps.push(Date.now());
    _oddsCache.previousData=_oddsCache.data||null;
    _oddsCache.data=Array.isArray(onlySoccer)?onlySoccer:null;
    _oddsCache.fetchedAt=Date.now();
    return {data:_oddsCache.data, previous:_oddsCache.previousData};
  }catch(e){ console.error("TheOdds",e?.message||e); return {data:null, previous:_oddsCache.previousData}; }
}

function buildOddsKeyFromEvent(evt){
  try{
    const home=normalizeTeamName(evt?.home_team || (evt?.teams&&evt.teams[0]) || "");
    const away=normalizeTeamName(evt?.away_team || (evt?.teams&&evt.teams[1]) || "");
    if(!home||!away) return null;
    return `${home} vs ${away}`;
  }catch{return null}
}
function computeMovementForMatch(sel,cur,prev){
  try{
    if(!cur||!prev) return 0;
    const c=impliedFromBestOdds(cur.best), p=impliedFromBestOdds(prev.best);
    const dh=c.home-p.home, dd=c.draw-p.draw, da=c.away-p.away;
    const norm=0.1;
    const mv={ ch:clamp(dh/norm,-1,1), cd:clamp(dd/norm,-1,1), ca:clamp(da/norm,-1,1) };
    return sel==='home'?mv.ch:sel==='draw'?mv.cd:mv.ca;
  }catch{return 0}
}

export default async function handler(req,res){
  try{
    const url=new URL(req.url,'http://localhost');
    const date=url.searchParams.get('date')||todayYMD('UTC');

    const fixturesJson=await fetchFixturesForDate(date);
    const fixtures=Array.isArray(fixturesJson?.data)?fixturesJson.data:[];

    // Mapiraj fixtures
    const rows=fixtures.map(f=>{
      const home=f?.localTeam?.data?.name||f?.localTeam?.data?.short_code||'Home';
      const away=f?.visitorTeam?.data?.name||f?.visitorTeam?.data?.short_code||'Away';
      const key = `${normalizeTeamName(home)} vs ${normalizeTeamName(away)}`;
      const utcStart = (f?.time?.starting_at?.date_time||"").replace(' ','T')+'Z';
      const belgrade = formatBelgradeDateTime(f?.time?.starting_at?.date_time?.replace(' ','T'));
      return {
        fixture_id: f?.id,
        key,
        utcStart,
        belgradeStart: belgrade,
        homeName: home,
        awayName: away,
        league: {
          id: f?.league?.data?.id || f?.league_id,
          name: f?.league?.data?.name || 'League',
          country_id: f?.league?.data?.country_id || null,
        },
      };
    });

    const {data:oddsData, previous:prevOddsData}=await fetchOddsSnapshotGuarded();
    const oddsMap=new Map(), prevOddsMap=new Map();

    if(Array.isArray(oddsData)){
      for(const evt of oddsData){
        const key=buildOddsKeyFromEvent(evt); if(!key) continue;
        const {best,bookmakerCount}=pickBestOddsForH2H(evt.bookmakers||[]);
        // Udaljenost po vremenu ne forsiramo – TheOdds nema isti ID; name matching je najrobustniji za free
        oddsMap.set(key,{best,bookmakerCount,event:evt});
      }
    }
    if(Array.isArray(prevOddsData)){
      for(const evt of prevOddsData){
        const key=buildOddsKeyFromEvent(evt); if(!key) continue;
        const {best,bookmakerCount}=pickBestOddsForH2H(evt.bookmakers||[]);
        prevOddsMap.set(key,{best,bookmakerCount,event:evt});
      }
    }

    const strict=[], weakPool=[];
    for(const r of rows){
      const model = baseModel1X2Prob();
      const oddsObj=oddsMap.get(r.key)||null, prevObj=prevOddsMap.get(r.key)||null;

      let type="FALLBACK", marketOdds=null, implied={home:0,draw:0,away:0}, bookies=0;
      if(oddsObj && (oddsObj.best?.home||oddsObj.best?.draw||oddsObj.best?.away)){
        type="MODEL+ODDS"; marketOdds=oddsObj.best; implied=impliedFromBestOdds(oddsObj.best); bookies=toNumber(oddsObj.bookmakerCount,0);
      }

      const edges={ home:model.home-implied.home, draw:model.draw-implied.draw, away:model.away-implied.away };
      let sel='home', selProb=model.home, selOdds=marketOdds?.home||null, selEdge=edges.home;
      if(edges.draw>selEdge){ sel='draw'; selProb=model.draw; selOdds=marketOdds?.draw||null; selEdge=edges.draw; }
      if(edges.away>selEdge){ sel='away'; selProb=model.away; selOdds=marketOdds?.away||null; selEdge=edges.away; }

      const hours=hoursUntil(r.utcStart);
      if(hours < 0.33) continue; // < ~20min do početka – preskačemo

      const hasOdds = (type==='MODEL+ODDS');
      const passStrict = hasOdds ? (selEdge>=MIN_EDGE_STRICT && toNumber(selOdds,0)>=MIN_ODDS && bookies>=4)
                                 : (selProb>=FALLBACK_STRICT_MIN);
      const passWeak   = hasOdds ? (selEdge>=MIN_EDGE_WEAK   && toNumber(selOdds,0)>=MIN_ODDS)
                                 : (selProb>=FALLBACK_WEAK_MIN);

      const movementScore = hasOdds ? computeMovementForMatch(sel,oddsObj,prevObj) : 0;
      const score=scoreFromEdge(selEdge,movementScore,bookies,hours);
      const selectionLabel = sel==='home'?'1':sel==='draw'?'X':'2';
      const confPct = Math.round(selProb*100);

      const pick={
        fixture_id:r.fixture_id,
        market:"1X2",
        selection:selectionLabel,
        type,
        model_prob:selProb,
        market_odds:hasOdds?selOdds:null,
        edge:hasOdds?selEdge:null,
        datetime_local:{ starting_at:{ date_time:r.belgradeStart } },
        teams:{ home:{name:r.homeName}, away:{name:r.awayName} },
        league:r.league,
        confidence_pct: confPct,
        confidence_bucket: confidenceBucket(selProb),
        _score: score,
      };

      if(passStrict) strict.push(pick);
      else if(passWeak) weakPool.push(pick);
    }

    // rangiranje i popuna
    strict.sort((a,b)=>toNumber(b._score,0)-toNumber(a._score,0));
    weakPool.sort((a,b)=>toNumber(b._score,0)-toNumber(a._score,0));

    const desired=10;
    const out=[...strict.slice(0,desired)];
    if(out.length<desired){
      const seen=new Set(out.map(x=>x.fixture_id));
      for(const w of weakPool){
        if(out.length>=desired) break;
        if(seen.has(w.fixture_id)) continue;
        out.push(w); seen.add(w.fixture_id);
      }
    }

    res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate=1800');
    return res.status(200).json({ value_bets: out, generated_at:new Date().toISOString() });

  }catch(e){
    console.error("value-bets fatal",e?.message||e);
    res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=300');
    return res.status(200).json({ value_bets: [], note:'error, returned empty' });
  }
}
