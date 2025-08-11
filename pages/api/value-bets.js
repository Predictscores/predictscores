// FILE: pages/api/value-bets.js
/**
 * Value Bets pipeline (API-Football canonical + rolling 24h)
 * - Rolling window: [now-12h, now+12h] u Europe/Belgrade
 * - Signals: predictions + odds (median) + edge + move + form (last5) + H2H (last=10) + lineups + injuries
 * - Dynamic confidence weights (sa/bez kvota)
 * - Server-side keš per sloj + soft dnevni budžet
 */

const AF = {
  BUDGET_DAILY: num(process.env.AF_BUDGET_DAILY, 5000),
  NEAR_WINDOW_MIN: num(process.env.AF_NEAR_WINDOW_MIN, 90),
  DEEP_TOP: num(process.env.AF_DEEP_TOP, 30),
  SNAPSHOT_INTERVAL_MIN: num(process.env.AF_SNAPSHOT_INTERVAL_MIN, 60),
  ODDS_MAX_CALLS_PER_DAY: num(process.env.ODDS_MAX_CALLS_PER_DAY, 12),
  ROLLING_WINDOW_HOURS: num(process.env.AF_ROLLING_WINDOW_HOURS, 24), // 24h
  H2H_LAST: num(process.env.AF_H2H_LAST, 10),
};

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_KEY = process.env.API_FOOTBALL_KEY;
const SM_KEY = process.env.SPORTMONKS_KEY || "";
const FD_KEY = process.env.FOOTBALL_DATA_KEY || "";
const ODDS_KEY = process.env.ODDS_API_KEY || "";

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ---------- in-memory cache ----------
const g = globalThis;
if (!g.__VB_CACHE__) {
  g.__VB_CACHE__ = {
    byKey: new Map(),
    oddsSnapshots: new Map(), // fixtureId -> { ts, priceMap }
    counters: { day: new Date().toISOString().slice(0,10), apiFootball: 0, sportMonks: 0, footballData: 0, theOdds: 0 },
  };
}
const CACHE = g.__VB_CACHE__;
function setCache(key, data, ttlSec=60){ CACHE.byKey.set(key,{data,exp:Date.now()+ttlSec*1000}); return data; }
function getCache(key){ const it=CACHE.byKey.get(key); if(!it) return null; if(Date.now()>it.exp){ CACHE.byKey.delete(key); return null; } return it.data; }
function incCounter(name){ const today=new Date().toISOString().slice(0,10); if(CACHE.counters.day!==today) CACHE.counters={day:today,apiFootball:0,sportMonks:0,footballData:0,theOdds:0}; CACHE.counters[name]=(CACHE.counters[name]||0)+1; }
function withinBudget(incr=1){ const today=new Date().toISOString().slice(0,10); if(CACHE.counters.day!==today) CACHE.counters={day:today,apiFootball:0,sportMonks:0,footballData:0,theOdds:0}; return CACHE.counters.apiFootball+incr<=AF.BUDGET_DAILY; }

// ---------- helpers ----------
function sanitizeIso(s){ if(!s||typeof s!=="string") return null; let iso=s.trim().replace(" ","T"); iso=iso.replace("+00:00Z","Z").replace("Z+00:00","Z"); return iso; }
function impliedFromDecimal(o){ const x=Number(o); return Number.isFinite(x)&&x>1.01?1/x:null; }
function bucketFromPct(p){ if(p>=90) return "TOP"; if(p>=75) return "High"; if(p>=50) return "Moderate"; return "Low"; }
function sum(a){ return a.reduce((x,y)=>x+y,0); }
function toLocalYMD(date, tz) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' })
    .format(date); // YYYY-MM-DD
}

// ---------- HTTP wrappers ----------
async function afFetch(path,{ttl=0}={}) {
  if(!AF_KEY) throw new Error("API_FOOTBALL_KEY missing");
  const url=`https://v3.football.api-sports.io${path}`;
  const ck=`AF:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; }
  if(!withinBudget()) throw new Error("AF budget exhausted");
  const res=await fetch(url,{headers:{ "x-apisports-key":AF_KEY }});
  incCounter("apiFootball"); if(!res.ok) throw new Error(`AF ${path} -> ${res.status}`);
  const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
}
async function smFetch(url,{ttl=0}={}) {
  const ck=`SM:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; }
  const res=await fetch(url); incCounter("sportMonks"); if(!res.ok) throw new Error(`SM ${url} -> ${res.status}`);
  const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
}
async function fdFetch(path,{ttl=0}={}) {
  const url=`https://api.football-data.org/v4${path}`;
  const ck=`FD:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; }
  const res=await fetch(url,{headers:{ "X-Auth-Token":FD_KEY }}); incCounter("footballData"); if(!res.ok) throw new Error(`FD ${path} -> ${res.status}`);
  const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
}

// ---------- data fetchers ----------
async function fetchAFByDate(ymd){
  const af=await afFetch(`/fixtures?date=${ymd}`,{ttl:15*60});
  return (af?.response||[]).map(f=>({
    source:"AF",
    fixture_id:f?.fixture?.id,
    league:{ id:f?.league?.id, name:f?.league?.name, country:f?.league?.country, season:f?.league?.season },
    teams:{ home:{ id:f?.teams?.home?.id, name:f?.teams?.home?.name }, away:{ id:f?.teams?.away?.id, name:f?.teams?.away?.name } },
    datetime_local:{ starting_at:{ date_time:sanitizeIso(f?.fixture?.date) } },
  })).filter(x=>x.teams?.home?.id && x.teams?.away?.id);
}

async function fetchFixturesRolling(nowUTC = new Date()){
  // rolling ± window/2 u Europe/Belgrade → pokrivamo juče/danas/sutra po lokalnom datumu
  const half = Math.max(1, Math.round(AF.ROLLING_WINDOW_HOURS/2));
  const startMs = nowUTC.getTime() - half*3600*1000;
  const endMs   = nowUTC.getTime() + half*3600*1000;

  // lokalni YMD za juče/danas/sutra
  const tz = TZ;
  const dNow = new Date(nowUTC);
  const dPrev = new Date(nowUTC); dPrev.setDate(dPrev.getDate()-1);
  const dNext = new Date(nowUTC); dNext.setDate(dNext.getDate()+1);
  const days = [toLocalYMD(dPrev,tz), toLocalYMD(dNow,tz), toLocalYMD(dNext,tz)];

  // API-Football je kanonski
  let afFixtures = [];
  for (const ymd of days) {
    try {
      const list = await fetchAFByDate(ymd);
      afFixtures = afFixtures.concat(list);
    } catch (_) {}
  }

  // Filtriraj po rolling prozoru
  const inWindow = afFixtures.filter(f => {
    const iso = sanitizeIso(f?.datetime_local?.starting_at?.date_time);
    if(!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });

  if (inWindow.length) return inWindow;

  // Fallback (retko): SportMonks / Football-Data ako baš nema AF (IDs nisu kanonski)
  // Ovo vraćamo samo da UI ne bude prazan (biće FALLBACK bez AF detalja)
  try {
    if (SM_KEY) {
      const ymd = toLocalYMD(dNow, tz);
      const url=`https://api.sportmonks.com/v3/football/fixtures/date/${ymd}?api_token=${SM_KEY}&include=participants;league;season`;
      const sm=await smFetch(url,{ttl:15*60});
      const list=(sm?.data||[]).map(f=>{
        const home=f?.participants?.find?.(p=>p.meta?.location==="home");
        const away=f?.participants?.find?.(p=>p.meta?.location==="away");
        return {
          source:"SM",
          fixture_id:f.id,
          league:{ id:f?.league?.id, name:f?.league?.name||"", country:f?.league?.country?.name||f?.league?.country||"", season:f?.season?.name||"" },
          teams:{ home:{ id:home?.id, name:home?.name }, away:{ id:away?.id, name:away?.name } },
          datetime_local:{ starting_at:{ date_time:sanitizeIso(f?.starting_at) } },
        };
      });
      if(list.length) return list;
    }
  } catch(_) {}

  try {
    if (FD_KEY) {
      const ymd = toLocalYMD(dNow, tz);
      const fd=await fdFetch(`/matches?dateFrom=${ymd}&dateTo=${ymd}`,{ttl:15*60});
      const list=(fd?.matches||[]).map(m=>({
        source:"FD",
        fixture_id:m?.id,
        league:{ id:m?.competition?.id, name:m?.competition?.name, country:"", season:m?.season?.startDate?.slice(0,4) },
        teams:{ home:{ id:m?.homeTeam?.id, name:m?.homeTeam?.name }, away:{ id:m?.awayTeam?.id, name:m?.awayTeam?.name } },
        datetime_local:{ starting_at:{ date_time:sanitizeIso(m?.utcDate) } },
      }));
      if(list.length) return list;
    }
  } catch(_) {}

  return [];
}

async function fetchPredictions(fixtureId){
  try{
    const j=await afFetch(`/predictions?fixture=${fixtureId}`,{ttl:30*60});
    const r=j?.response?.[0]; const preds=r?.predictions||r;
    let p1=preds?.percent?.home, px=preds?.percent?.draw, p2=preds?.percent?.away;
    const clean=v=>typeof v==="string"?parseFloat(v)/100:Number(v);
    p1=clean(p1); px=clean(px); p2=clean(p2);
    const t=[p1,px,p2].filter(Number.isFinite).reduce((a,b)=>a+b,0);
    if(t>0){ p1=(p1||0)/t; px=(px||0)/t; p2=(p2||0)/t; return {p1,px,p2}; }
  }catch(_){}
  return null;
}

async function fetchOdds(fixtureId){
  try{
    const j=await afFetch(`/odds?fixture=${fixtureId}`,{ttl:10*60});
    const resp=j?.response||[];
    const prices={"1":[],X:[],"2":[]};
    for(const row of resp){
      const bets=row?.bookmakers?.[0]?.bets||[];
      for(const m of bets){
        const n=(m?.name||"").toLowerCase();
        if(n.includes("match winner")||n.includes("1x2")){
          for(const v of m.values||[]){
            const lbl=(v?.value||"").toUpperCase(); const odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if(lbl==="HOME"||lbl==="1") prices["1"].push(odd);
            if(lbl==="DRAW"||lbl==="X") prices["X"].push(odd);
            if(lbl==="AWAY"||lbl==="2") prices["2"].push(odd);
          }
        }
      }
    }
    const median=arr=>arr.length? (arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)]) : null;
    return { odds:{ "1":median(prices["1"]), X:median(prices["X"]), "2":median(prices["2"]) }, bookmakers_count:resp.length||0 };
  }catch(_){}
  return null;
}

async function fetchTeamStats(leagueId,season,teamId){
  try{ const j=await afFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`,{ttl:12*3600}); return j?.response||null; }catch(_){}
  return null;
}

async function fetchH2H(homeId,awayId,last){
  try{
    const j=await afFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${last}`,{ttl:24*3600});
    const games=j?.response||[];
    let w=0,d=0,l=0,gs=0,ga=0;
    for(const g of games){
      const hs=g?.goals?.home ?? g?.score?.fulltime?.home;
      const as=g?.goals?.away ?? g?.score?.fulltime?.away;
      if(Number.isFinite(hs)&&Number.isFinite(as)){ gs+=hs; ga+=as; if(hs>as) w++; else if(hs===as) d++; else l++; }
    }
    const summary=games.length?`W${w} D${d} L${l} · ${gs}:${ga}`:"";
    return { summary, count: games.length };
  }catch(_){}
  return { summary:"", count:0 };
}

async function fetchInjuries(fixtureId){
  try{ const j=await afFetch(`/injuries?fixture=${fixtureId}`,{ttl:10*60}); return { count:(j?.response||[]).length||0 }; }catch(_){}
  return { count:0 };
}

async function fetchLineups(fixtureId){
  try{
    const j=await afFetch(`/fixtures/lineups?fixture=${fixtureId}`,{ttl:5*60});
    const ln=j?.response||[]; const confirmed=ln.some(x=>Array.isArray(x?.startXI)&&x.startXI.length>0);
    return { status: confirmed ? "confirmed" : (ln.length ? "expected" : "unknown") };
  }catch(_){}
  return { status:"unknown" };
}

function pickFromPredictions(preds){ const map={ "1":preds?.p1||0, X:preds?.px||0, "2":preds?.p2||0 }; const sel=Object.keys(map).sort((a,b)=>map[b]-map[a])[0]||"1"; return { selection:sel, model_prob: map[sel]||0 }; }
function edgeFromOdds(sel, modelProb, odds){ const price=sel&&odds?odds[sel]:null; const implied=impliedFromDecimal(price); if(!Number.isFinite(implied)) return { market_odds:null, implied_prob:null, edge:null }; return { market_odds:price, implied_prob:implied, edge: modelProb - implied }; }
function movementForFixture(fxId, oddsObj){
  const prev=CACHE.oddsSnapshots.get(fxId);
  const map={ "1":oddsObj?.["1"], X:oddsObj?.X, "2":oddsObj?.["2"] };
  CACHE.oddsSnapshots.set(fxId,{ ts:Date.now(), priceMap:map });
  if(!prev||!prev.priceMap) return 0;
  const keys=["1","X","2"];
  const prevImp=keys.map(k=>impliedFromDecimal(prev.priceMap[k])).filter(Number.isFinite);
  const nowImp=keys.map(k=>impliedFromDecimal(map[k])).filter(Number.isFinite);
  if(!prevImp.length||!nowImp.length) return 0;
  const prevAvg=sum(prevImp)/prevImp.length, nowAvg=sum(nowImp)/nowImp.length;
  return Math.round((nowAvg-prevAvg)*10000)/100; // percentage points
}

function computeFormScore(statsHome,statsAway){
  const score=s=>{ const f=s?.form || s?.fixtures?.form || ""; if(!f) return null; const map={W:1,D:0.5,L:0}; const vals=f.toString().slice(-5).split("").map(c=>map[c]??0); return vals.length? vals.reduce((a,b)=>a+b,0)/vals.length : null; };
  const sh=score(statsHome), sa=score(statsAway);
  const text = (statsHome?.form || statsHome?.fixtures?.form || "") && (statsAway?.form || statsAway?.fixtures?.form || "")
    ? `${(statsHome?.form||statsHome?.fixtures?.form||"").slice(-5)} vs ${(statsAway?.form||statsAway?.fixtures?.form||"").slice(-5)}`
    : "";
  if(sh==null || sa==null) return { score: 0.5, text };
  return { score: Math.max(0,Math.min(1,0.5+(sh-sa)/2)), text };
}

function explainBlock(v){
  const bits=[];
  if(v.form_text) bits.push(`Forma: ${v.form_text}`);
  if(v.h2h_summary) bits.push(`H2H: ${v.h2h_summary}`);
  if(v.lineups_status==="confirmed") bits.push("Postave potvrđene");
  if(Number.isFinite(v.injuries_count)&&v.injuries_count>0) bits.push(`Povrede: ${v.injuries_count}`);
  if(Number.isFinite(v.movement_pct)&&v.movement_pct!==0) bits.push(`Tržište: ${v.movement_pct>0?"↑":"↓"} ${Math.abs(v.movement_pct).toFixed(2)}pp`);
  const summary=[
    v.type==="MODEL+ODDS"&&Number.isFinite(v.edge)?`Edge ${Math.round(v.edge*100)}pp`:null,
    v.model_prob?`Model ${Math.round(v.model_prob*100)}%`:null,
  ].filter(Boolean).join(" · ");
  return { summary, bullets: bits, factors: { model:v.model_prob||null, edge:v.edge||null, injuries:v.injuries_count||0, movement_pp:v.movement_pct||0 } };
}

function overallConfidence(v){
  const hasOdds = Number.isFinite(v.market_odds) && Number.isFinite(v.implied_prob);
  const pPred=v.model_prob||0;
  const edge=Number.isFinite(v.edge)?Math.max(-0.15,Math.min(0.15,v.edge)):0;
  const form=v.form_score||0;
  const h2h=v.h2h_score||0; // zadržano za buduće fino-štimovanje
  const lineups=v.lineups_status==="confirmed"?1:(v.lineups_status==="expected"?0.6:0.4);
  const injuries=Math.max(0,1-Math.min(1,(v.injuries_count||0)/5));
  const move=Math.max(0,1+(v.movement_pct||0)/10);

  // Dinamičke težine: sa kvotama edge/move teže više; bez kvota blag penalti
  const W = hasOdds
    ? { pred:0.30, edge:0.22, form:0.15, h2h:0.10, lineups:0.10, inj:0.08, move:0.05 }
    : { pred:0.38, edge:0.06, form:0.20, h2h:0.12, lineups:0.12, inj:0.10, move:0.02 };

  const base = W.pred*pPred + W.edge*(0.5+edge) + W.form*form + W.h2h*h2h + W.lineups*(lineups/1.1) + W.inj*injuries + W.move*Math.min(1.2,move);

  // Blagi clamp i penalti kad baš nema ničega
  const score = Math.max(0, Math.min(1, base));
  return hasOdds ? score : Math.max(0, score - 0.03);
}

export default async function handler(req,res){
  const debug=req.query.debug==="1"||req.query.debug==="true";
  const t0=Date.now();

  let fixtures=[];
  try{ fixtures=await fetchFixturesRolling(new Date()); }catch(_){}

  const out=[];
  for(const f of fixtures){
    const fx=f.fixture_id, leagueId=f.league?.id, season=f.league?.season, homeId=f.teams?.home?.id, awayId=f.teams?.away?.id;

    // Predictions
    let preds=null; if(withinBudget(1) && f.source==="AF") preds=await fetchPredictions(fx).catch(()=>null);
    let model_prob=null, selection="1";
    if(preds){ const pick=pickFromPredictions(preds); model_prob=pick.model_prob; selection=pick.selection; }
    else { model_prob=num(process.env.FALLBACK_MIN_PROB,0.52); selection="1"; }

    // Form + H2H (last=AF.H2H_LAST)
    let statsHome=null, statsAway=null;
    if(withinBudget(2) && f.source==="AF" && leagueId && season){
      [statsHome,statsAway]=await Promise.all([
        fetchTeamStats(leagueId,season,homeId).catch(()=>null),
        fetchTeamStats(leagueId,season,awayId).catch(()=>null),
      ]);
    }
    const { score:form_score, text:form_text } = computeFormScore(statsHome,statsAway);

    const h2h = (withinBudget(1) && f.source==="AF")
      ? await fetchH2H(homeId,awayId,AF.H2H_LAST).catch(()=>({summary:"",count:0}))
      : { summary:"", count:0 };

    // Odds
    let oddsPack=null;
    if(withinBudget(1) && f.source==="AF") oddsPack=await fetchOdds(fx).catch(()=>null);
    const { odds, bookmakers_count } = oddsPack || {};
    const { market_odds, implied_prob, edge } = edgeFromOdds(selection,model_prob,odds||null);
    const movement_pct = odds ? movementForFixture(fx,odds) : 0;

    // Near-kickoff
    let injuries_count=0; let lineups_status="unknown";
    const kickoffISO=sanitizeIso(f?.datetime_local?.starting_at?.date_time);
    const minsTo = kickoffISO ? Math.round((new Date(kickoffISO).getTime()-Date.now())/60000) : null;
    if(minsTo!==null && minsTo<=AF.NEAR_WINDOW_MIN && minsTo>=-180 && f.source==="AF"){
      if(withinBudget(2)){
        const [inj,lin]=await Promise.all([
          fetchInjuries(fx).catch(()=>({count:0})),
          fetchLineups(fx).catch(()=>({status:"unknown"})),
        ]);
        injuries_count=inj.count||0; lineups_status=lin.status||"unknown";
      }
    }

    const base={
      fixture_id:fx, market:"1X2", selection,
      type: Number.isFinite(market_odds) ? "MODEL+ODDS" : "FALLBACK",
      model_prob, market_odds: Number.isFinite(market_odds)?market_odds:null,
      implied_prob: Number.isFinite(implied_prob)?implied_prob:null,
      edge: Number.isFinite(edge)?edge:null,
      movement_pct: Number.isFinite(movement_pct)?movement_pct:0,
      datetime_local:{ starting_at:{ date_time: kickoffISO } },
      teams:f.teams, league:f.league,
      confidence_pct:0, confidence_bucket:"Low", _score:0,
      form_score, form_text,
      h2h_summary: h2h.summary || "", h2h_count: h2h.count || 0,
      lineups_status, injuries_count,
      bookmakers_count: Number.isFinite(bookmakers_count)?bookmakers_count:0,
    };

    const conf=overallConfidence(base);
    base._score=Math.round(conf*100);
    base.confidence_pct=Math.round(conf*100);
    base.confidence_bucket=bucketFromPct(base.confidence_pct);
    base.explain=explainBlock(base);

    out.push(base);
  }

  // ranking
  out.sort((a,b)=> {
    if(a.type!==b.type) return a.type==="MODEL+ODDS"?-1:1;
    if(b._score!==a._score) return b._score-a._score;
    const aE=Number.isFinite(a.edge)?a.edge:-1, bE=Number.isFinite(b.edge)?b.edge:-1;
    return bE-aE;
  });

  const top=out.slice(0,10);

  const payload={
    generated_at:new Date().toISOString(),
    tz_display:TZ,
    value_bets:top,
    _meta: debug ? {
      total_candidates: fixtures.length,
      counters: CACHE.counters,
      window_hours: AF.ROLLING_WINDOW_HOURS,
      took_ms: Date.now()-t0,
    } : undefined,
  };

  res.setHeader("Cache-Control","s-maxage=60, stale-while-revalidate=60");
  res.status(200).json(payload);
}
