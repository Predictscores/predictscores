// FILE: pages/api/value-bets.js
//
// Dnevni TOP value betovi (fudbal) – štedljiv pipeline.
// - SportMonks fixtures (1x/dan; cache)
// - The Odds (guarded; cache); ako nema kvota → FALLBACK bez rušenja
// - Uvek vraća do 10 predloga; ako nema dovoljno “jakih”, dopuni slabijima
//
// NOVO: league info, confidence (pct + bucket), mekši fallback prag (0.52)

export const config = { api: { bodyParser: false } };

const SPORTMONKS_KEY = process.env.SPORTMONKS_KEY || "";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_MAX_CALLS_PER_DAY = Number(process.env.ODDS_MAX_CALLS_PER_DAY || "12");
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";
const FALLBACK_MIN_PROB_ENV = Number(process.env.FALLBACK_MIN_PROB || "0.52");

let _fixturesCache = { date: null, data: null, fetchedAt: 0 };
let _oddsCache = {
  dayKey: null, data: null, fetchedAt: 0,
  lastCallTimestamps: [], previousData: null
};

function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function toNumber(x,def=0){const n=Number(x);return Number.isFinite(n)?n:def}
function todayYMD(tz="UTC"){
  const d=new Date();
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const [{value:y},, {value:m},, {value:dd}] = fmt.formatToParts(d);
  return `${y}-${m}-${dd}`;
}
function formatBelgradeDateTime(isoUtc){
  try{
    if(!isoUtc) return "";
    const d=new Date(isoUtc.endsWith("Z")?isoUtc:isoUtc+"Z");
    const fmtDate=new Intl.DateTimeFormat('en-CA',{timeZone:TZ_DISPLAY,year:'numeric',month:'2-digit',day:'2-digit'});
    const fmtTime=new Intl.DateTimeFormat('en-GB',{timeZone:TZ_DISPLAY,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const [{value:y},, {value:m},, {value:da}] = fmtDate.formatToParts(d);
    return `${y}-${m}-${da} ${fmtTime.format(d)}`;
  }catch{return isoUtc}
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
    const home=out.find(o=>o.name?.toLowerCase()==='home')||out[0];
    const away=out.find(o=>o.name?.toLowerCase()==='away')||out[1];
    const draw=out.find(o=>(o.name||'').toLowerCase()==='draw')||out.find(o=>(o.name||'').toLowerCase()==='tie');
    if(home?.price) best.home=Math.max(best.home,home.price);
    if(away?.price) best.away=Math.max(best.away,away.price);
    if(draw?.price) best.draw=Math.max(best.draw,draw.price);
    count++;
  }
  return {best,bookmakerCount:count};
}
function baseModel1X2Prob(fix){
  const posH=toNumber(fix?.standings?.localteam_position,0);
  const posA=toNumber(fix?.standings?.visitorteam_position,0);
  const homeAdv=0.08; let posAdj=0;
  if(posH>0&&posA>0){ const diff=posA-posH; posAdj=clamp(diff/20,-0.10,0.10); }
  let pH=0.33+homeAdv+posAdj, pA=0.33-homeAdv-posAdj, pD=1-(pH+pA);
  pH=clamp(pH,0.10,0.75); pA=clamp(pA,0.10,0.75); pD=clamp(pD,0.10,0.40);
  const s=pH+pD+pA; return {home:pH/s, draw:pD/s, away:pA/s};
}
function scoreFromEdge(edge,movement=0,bookies=0,hoursToKO=24){
  const edgePct=clamp(edge,-1,1), mov=clamp(movement,-1,1), bk=clamp(bookies/10,0,1);
  const t = hoursToKO>=6?0.6:hoursToKO>=3?0.5:0.3;
  const score = 0.55*edgePct + 0.20*mov + 0.15*bk + 0.10*(1-Math.abs(t-0.45));
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

async function fetchFixturesForDate(dateYMD){
  try{
    if(_fixturesCache.date===dateYMD && _fixturesCache.data && Date.now()-_fixturesCache.fetchedAt<6*3600_000){
      return _fixturesCache.data;
    }
    const url=`https://soccer.sportmonks.com/api/v2.0/fixtures/date/${dateYMD}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(SPORTMONKS_KEY)}&tz=UTC`;
    const res=await fetch(url);
    if(!res.ok) throw new Error(`SportMonks HTTP ${res.status}`);
    const json=await res.json();
    _fixturesCache={date:dateYMD,data:json,fetchedAt:Date.now()};
    return json;
  }catch(e){ console.error("SportMonks",e?.message||e); return {data:[]} }
}

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
    const params=new URLSearchParams({
      regions:"eu", markets:"h2h,btts,totals", oddsFormat:"decimal", apiKey:ODDS_API_KEY
    });
    const url=`https://api.the-odds-api.com/v4/sports/soccer/odds?${params.toString()}`;
    const res=await fetch(url,{headers:{accept:'application/json'}});
    if(!res.ok){ console.warn("TheOdds HTTP",res.status); return {data:null, previous:_oddsCache.previousData}; }
    const json=await res.json();
    _oddsCache.lastCallTimestamps.push(Date.now());
    _oddsCache.previousData=_oddsCache.data||null;
    _oddsCache.data=Array.isArray(json)?json:null;
    _oddsCache.fetchedAt=Date.now();
    return {data:_oddsCache.data, previous:_oddsCache.previousData};
  }catch(e){ console.error("TheOdds",e?.message||e); return {data:null, previous:_oddsCache.previousData}; }
}
function computeMovementForMatch(key,cur,prev){
  try{
    if(!cur||!prev) return 0;
    const c=impliedFromBestOdds(cur.best), p=impliedFromBestOdds(prev.best);
    const dh=c.home-p.home, dd=c.draw-p.draw, da=c.away-p.away;
    const norm=0.1;
    return { ch:clamp(dh/norm,-1,1), cd:clamp(dd/norm,-1,1), ca:clamp(da/norm,-1,1) };
  }catch{return 0}
}

export default async function handler(req,res){
  try{
    const url=new URL(req.url,'http://localhost');
    const date=url.searchParams.get('date')||todayYMD('UTC');
    const minEdge=toNumber(url.searchParams.get('min_edge'),0.05);
    const minOdds=toNumber(url.searchParams.get('min_odds'),1.3);
    const fallbackMinProb=toNumber(url.searchParams.get('fallback_min_prob'),FALLBACK_MIN_PROB_ENV);

    const fixturesJson=await fetchFixturesForDate(date);
    const fixtures=Array.isArray(fixturesJson?.data)?fixturesJson.data:[];
    const rows=fixtures.map(f=>{
      const home=f?.localTeam?.data?.name||f?.localTeam?.data?.short_code||'Home';
      const away=f?.visitorTeam?.data?.name||f?.visitorTeam?.data?.short_code||'Away';
      const key=normalizeTeamName(home)+" vs "+normalizeTeamName(away);
      const utcStart=f?.time?.starting_at?.date_time?.replace(' ','T')+'Z';
      const belgrade=formatBelgradeDateTime(f?.time?.starting_at?.date_time?.replace(' ','T'));
      return {
        fixture_id:f?.id,
        league_id:f?.league_id,
        league: {
          id: f?.league?.data?.id || f?.league_id,
          name: f?.league?.data?.name || 'League',
          country_id: f?.league?.data?.country_id || null,
        },
        key, utcStart, belgradeStart:belgrade,
        homeName:home, awayName:away,
        standings:{
          localteam_position:f?.standings?.localteam_position,
          visitorteam_position:f?.standings?.visitorteam_position,
        },
        raw:f,
      };
    });

    const {data:oddsData, previous:prevOddsData}=await fetchOddsSnapshotGuarded();
    const oddsMap=new Map(), prevOddsMap=new Map();
    function buildOddsKey(evt){
      try{
        const home=normalizeTeamName(evt?.home_team || (evt?.teams&&evt.teams[0]) || "");
        const away=normalizeTeamName(evt?.away_team || (evt?.teams&&evt.teams[1]) || "");
        if(!home||!away) return null; return home+" vs "+away;
      }catch{return null}
    }
    if(Array.isArray(oddsData)){
      for(const evt of oddsData){
        const key=buildOddsKey(evt); if(!key) continue;
        const {best,bookmakerCount}=pickBestOddsForH2H(evt.bookmakers||[]);
        oddsMap.set(key,{best,bookmakerCount,event:evt});
      }
    }
    if(Array.isArray(prevOddsData)){
      for(const evt of prevOddsData){
        const key=buildOddsKey(evt); if(!key) continue;
        const {best,bookmakerCount}=pickBestOddsForH2H(evt.bookmakers||[]);
        prevOddsMap.set(key,{best,bookmakerCount,event:evt});
      }
    }

    const strict=[], weakPool=[];
    for(const r of rows){
      const model = baseModel1X2Prob({standings:r.standings});
      const oddsObj=oddsMap.get(r.key)||null, prevObj=prevOddsMap.get(r.key)||null;
      let type="FALLBACK", marketOdds=null, implied={home:0,draw:0,away:0}, bookies=0;
      if(oddsObj && (oddsObj.best?.home||oddsObj.best?.draw||oddsObj.best?.away)){
        type="MODEL+ODDS"; marketOdds=oddsObj.best; implied=impliedFromBestOdds(oddsObj.best); bookies=toNumber(oddsObj.bookmakerCount,0);
      }
      const edges={ home:model.home-implied.home, draw:model.draw-implied.draw, away:model.away-implied.away };
      let sel='home', selProb=model.home, selOdds=marketOdds?.home||null, selEdge=edges.home;
      if(edges.draw>selEdge){ sel='draw'; selProb=model.draw; selOdds=marketOdds?.draw||null; selEdge=edges.draw; }
      if(edges.away>selEdge){ sel='away'; selProb=model.away; selOdds=marketOdds?.away||null; selEdge=edges.away; }

      const hours=hoursUntil(r.utcStart); if(hours<0.33) continue; // <20min

      const hasOdds=(type==='MODEL+ODDS');
      const passStrict = hasOdds ? (selEdge>=minEdge && toNumber(selOdds,0)>=minOdds && bookies>=4)
                                 : (selProb>=fallbackMinProb);
      const passWeak   = hasOdds ? (selEdge>=minEdge*0.6 && toNumber(selOdds,0)>=minOdds)
                                 : (selProb>=Math.max(0.48, fallbackMinProb-0.04)); // mekši fill

      let movementScore=0;
      if(hasOdds && prevObj){
        const mv=computeMovementForMatch(r.key,oddsObj,prevObj);
        if(mv && typeof mv==='object'){ movementScore = sel==='home'?mv.ch:sel==='draw'?mv.cd:mv.ca; }
      }
      const score=scoreFromEdge(selEdge,movementScore,bookies,hours);
      const selectionLabel = sel==='home'?'1':sel==='draw'?'X':'2';
      const confPct=Math.round(selProb*100);

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
        league:r.league,                  // <--- NOVO
        confidence_pct: confPct,          // <--- NOVO
        confidence_bucket: confidenceBucket(selProb), // <--- NOVO
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
      // popuni slabijima, ali izbegni duplikate fixture_id
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
