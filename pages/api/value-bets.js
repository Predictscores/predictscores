// FILE: pages/api/value-bets.js
/**
 * Value Bets (multi-market): 1X2 / BTTS / Over2.5
 * - Rolling window: [now-12h, now+12h] u Europe/Belgrade (više mečeva kroz dan)
 * - Markets:
 *    • 1X2 -> AF predictions kao model (p1,px,p2)
 *    • BTTS (Yes/No) -> Poisson iz team stats (λh, λa)
 *    • Over 2.5 -> Poisson iz λsum (CDF)
 * - Odds: median preko AF /odds?fixture= (isti response, bez novih poziva)
 * - Izbor najboljeg marketa po EV, sa edge/EV/odds u izlazu
 * - Confidence: težine jače kad postoje kvote; blagi penalti kad ne postoje
 * - H2H last=10, lineups/injuries u <90min prozoru
 * - Server-side cache (in-memory) i dnevni soft budžet
 */

const AF = {
  BUDGET_DAILY: num(process.env.AF_BUDGET_DAILY, 5000),
  NEAR_WINDOW_MIN: num(process.env.AF_NEAR_WINDOW_MIN, 90),
  ROLLING_WINDOW_HOURS: num(process.env.AF_ROLLING_WINDOW_HOURS, 24),
  H2H_LAST: num(process.env.AF_H2H_LAST, 10),
};

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_KEY = process.env.API_FOOTBALL_KEY;
const SM_KEY = process.env.SPORTMONKS_KEY || "";
const FD_KEY = process.env.FOOTBALL_DATA_KEY || "";

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ---------- in-memory cache ----------
const g = globalThis;
if (!g.__VB_CACHE__) {
  g.__VB_CACHE__ = {
    byKey: new Map(),
    oddsSnapshots: new Map(), // key: `${fxId}|${market}|${sel}` -> { ts, implied }
    counters: { day: new Date().toISOString().slice(0,10), apiFootball: 0, sportMonks: 0, footballData: 0 },
  };
}
const CACHE = g.__VB_CACHE__;
function setCache(k, data, ttlSec=60){ CACHE.byKey.set(k,{data,exp:Date.now()+ttlSec*1000}); return data; }
function getCache(k){ const it=CACHE.byKey.get(k); if(!it) return null; if(Date.now()>it.exp){ CACHE.byKey.delete(k); return null; } return it.data; }
function inc(name){ const today=new Date().toISOString().slice(0,10); if(CACHE.counters.day!==today) CACHE.counters={day:today,apiFootball:0,sportMonks:0,footballData:0}; CACHE.counters[name]=(CACHE.counters[name]||0)+1; }
function withinBudget(incr=1){ const today=new Date().toISOString().slice(0,10); if(CACHE.counters.day!==today) CACHE.counters={day:today,apiFootball:0,sportMonks:0,footballData:0}; return CACHE.counters.apiFootball+incr<=AF.BUDGET_DAILY; }

// ---------- helpers ----------
function sanitizeIso(s){ if(!s||typeof s!=="string") return null; let iso=s.trim().replace(" ","T"); iso=iso.replace("+00:00Z","Z").replace("Z+00:00","Z"); return iso; }
function impliedFromDecimal(o){ const x=Number(o); return Number.isFinite(x)&&x>1.01?1/x:null; }
function toLocalYMD(d, tz){ return new Intl.DateTimeFormat("sv-SE",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d); }
function bucketFromPct(p){ if(p>=90) return "TOP"; if(p>=75) return "High"; if(p>=50) return "Moderate"; return "Low"; }
function sum(a){ return a.reduce((x,y)=>x+y,0); }
function evFrom(p, o){ const odds=Number(o); if(!Number.isFinite(odds)||odds<=1.01) return null; return p*(odds-1) - (1-p); }

// Poisson helpers
function expm1(x){ return Math.exp(x)-1; }
function poissonPMF(k, lambda){ if(lambda<=0) return k===0?1:0; // robust
  // use log form to avoid overflow
  let logP = -lambda; for(let i=1;i<=k;i++) logP += Math.log(lambda) - Math.log(i);
  return Math.exp(logP);
}
function poissonCDF(k, lambda){ // P(X <= k)
  let acc=0; for(let i=0;i<=k;i++) acc+=poissonPMF(i,lambda); return acc;
}

// ---------- HTTP wrappers ----------
async function afFetch(path,{ttl=0}={}) {
  if(!AF_KEY) throw new Error("API_FOOTBALL_KEY missing");
  const url=`https://v3.football.api-sports.io${path}`;
  const ck=`AF:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; }
  if(!withinBudget()) throw new Error("AF budget exhausted");
  const res=await fetch(url,{headers:{ "x-apisports-key":AF_KEY }});
  inc("apiFootball"); if(!res.ok) throw new Error(`AF ${path} -> ${res.status}`);
  const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
}
async function smFetch(url,{ttl=0}={}) {
  const ck=`SM:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; }
  const res=await fetch(url); inc("sportMonks"); if(!res.ok) throw new Error(`SM ${url} -> ${res.status}`);
  const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
}
async function fdFetch(path,{ttl=0}={}) {
  const url=`https://api.football-data.org/v4${path}`;
  const ck=`FD:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; }
  const res=await fetch(url,{headers:{ "X-Auth-Token":FD_KEY }}); inc("footballData"); if(!res.ok) throw new Error(`FD ${path} -> ${res.status}`);
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

async function fetchFixturesRolling(nowUTC=new Date()){
  const half = Math.max(1, Math.round(AF.ROLLING_WINDOW_HOURS/2));
  const startMs = nowUTC.getTime() - half*3600*1000;
  const endMs   = nowUTC.getTime() + half*3600*1000;

  const tz=TZ;
  const dNow=new Date(nowUTC);
  const dPrev=new Date(nowUTC); dPrev.setDate(dPrev.getDate()-1);
  const dNext=new Date(nowUTC); dNext.setDate(dNext.getDate()+1);

  const days=[toLocalYMD(dPrev,tz),toLocalYMD(dNow,tz),toLocalYMD(dNext,tz)];
  let list=[];
  for(const ymd of days){ try{ list=list.concat(await fetchAFByDate(ymd)); }catch(_){} }

  const inWindow=list.filter(f=>{
    const iso=sanitizeIso(f?.datetime_local?.starting_at?.date_time);
    if(!iso) return false;
    const t=new Date(iso).getTime();
    return Number.isFinite(t)&&t>=startMs&&t<=endMs;
  });

  if(inWindow.length) return inWindow;

  // fallback da UI ne bude prazan (IDs nisu kompatibilni za AF detalje)
  if(SM_KEY){ try{
    const ymd=toLocalYMD(dNow,tz);
    const url=`https://api.sportmonks.com/v3/football/fixtures/date/${ymd}?api_token=${SM_KEY}&include=participants;league;season`;
    const sm=await smFetch(url,{ttl:15*60});
    if(sm?.data?.length){
      return sm.data.map(f=>{
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
    }
  }catch(_){}} else if(FD_KEY){
    try{
      const ymd=toLocalYMD(dNow,tz);
      const fd=await fdFetch(`/matches?dateFrom=${ymd}&dateTo=${ymd}`,{ttl:15*60});
      return (fd?.matches||[]).map(m=>({
        source:"FD",
        fixture_id:m?.id,
        league:{ id:m?.competition?.id, name:m?.competition?.name, country:"", season:m?.season?.startDate?.slice(0,4) },
        teams:{ home:{ id:m?.homeTeam?.id, name:m?.homeTeam?.name }, away:{ id:m?.awayTeam?.id, name:m?.awayTeam?.name } },
        datetime_local:{ starting_at:{ date_time:sanitizeIso(m?.utcDate) } },
      }));
    }catch(_){}
  }

  return [];
}

async function fetchPredictions(fx){
  try{
    const j=await afFetch(`/predictions?fixture=${fx}`,{ttl:30*60});
    const r=j?.response?.[0]; const preds=r?.predictions||r;
    let p1=preds?.percent?.home, px=preds?.percent?.draw, p2=preds?.percent?.away;
    const clean=v=>typeof v==="string"?parseFloat(v)/100:Number(v);
    p1=clean(p1); px=clean(px); p2=clean(p2);
    const t=[p1,px,p2].filter(Number.isFinite).reduce((a,b)=>a+b,0);
    if(t>0){ p1=(p1||0)/t; px=(px||0)/t; p2=(p2||0)/t; return {p1,px,p2}; }
  }catch(_){}
  return null;
}

async function fetchOdds(fx){
  try{
    const j=await afFetch(`/odds?fixture=${fx}`,{ttl:10*60});
    const resp=j?.response||[];
    // Normalize markets we care about
    const acc = { '1X2':{ "1":[], "X":[], "2":[] }, 'BTTS':{ Yes:[], No:[] }, 'OU':{} }; // OU by line: { '2.5': { Over:[], Under:[] } }
    for(const row of resp){
      const bets=row?.bookmakers?.[0]?.bets||[];
      for(const m of bets){
        const name=(m?.name||"").toLowerCase();

        // 1X2
        if(name.includes("match winner")||name.includes("1x2")){
          for(const v of m.values||[]){
            const lbl=(v?.value||"").toUpperCase();
            const odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if(lbl==="HOME"||lbl==="1") acc['1X2']["1"].push(odd);
            if(lbl==="DRAW"||lbl==="X") acc['1X2']["X"].push(odd);
            if(lbl==="AWAY"||lbl==="2") acc['1X2']["2"].push(odd);
          }
        }

        // BTTS
        if(name.includes("both teams to score") || name.includes("btts")){
          for(const v of m.values||[]){
            const lbl=(v?.value||"").toLowerCase();
            const odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if(lbl.includes("yes")) acc['BTTS'].Yes.push(odd);
            if(lbl.includes("no"))  acc['BTTS'].No.push(odd);
          }
        }

        // Totals (Over/Under)
        if(name.includes("over/under") || name.includes("goals over/under") || name.includes("totals")){
          for(const v of m.values||[]){
            const lbl=(v?.value||"").toLowerCase(); // e.g., "Over 2.5"
            const odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            const parts=lbl.split(" ");
            const side=parts[0]; // "over"|"under"
            const lineStr=parts[1] || "";
            if(!lineStr) continue;
            const line=parseFloat(lineStr);
            if(!Number.isFinite(line)) continue;
            const key=line.toFixed(1);
            if(!acc['OU'][key]) acc['OU'][key]={ Over:[], Under:[] };
            if(side.startsWith("over"))  acc['OU'][key].Over.push(odd);
            if(side.startsWith("under")) acc['OU'][key].Under.push(odd);
          }
        }
      }
    }

    const median=arr=>arr.length? (arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)]) : null;

    const odds = {
      "1X2": { "1": median(acc['1X2']["1"]), "X": median(acc['1X2']["X"]), "2": median(acc['1X2']["2"]) },
      "BTTS": { "Yes": median(acc['BTTS'].Yes), "No": median(acc['BTTS'].No) },
      "OU": {}
    };
    for(const line of Object.keys(acc['OU'])){
      odds["OU"][line] = { "Over": median(acc['OU'][line].Over), "Under": median(acc['OU'][line].Under) };
    }

    return { odds, bookmakers_count: resp.length||0 };
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
async function fetchInjuries(fx){ try{ const j=await afFetch(`/injuries?fixture=${fx}`,{ttl:10*60}); return { count:(j?.response||[]).length||0 }; }catch(_){return {count:0}} }
async function fetchLineups(fx){ try{ const j=await afFetch(`/fixtures/lineups?fixture=${fx}`,{ttl:5*60}); const ln=j?.response||[]; const confirmed=ln.some(x=>Array.isArray(x?.startXI)&&x.startXI.length>0); return { status: confirmed ? "confirmed" : (ln.length ? "expected" : "unknown") }; }catch(_){return {status:"unknown"}} }

// --- model pieces ---
function pickFromPreds(preds){ const map={ "1":preds?.p1||0, "X":preds?.px||0, "2":preds?.p2||0 }; const sel=Object.keys(map).sort((a,b)=>map[b]-map[a])[0]||"1"; return { selection:sel, prob: map[sel]||0 }; }
function poissonLambdas(statsHome, statsAway){
  // pokušaj home/away proseka; fallback na overall ili razuman default
  const get = (s, path) => path.split(".").reduce((o,k)=>o?.[k], s);
  let λh = Number(get(statsHome,"goals.for.average.home")) || Number(get(statsHome,"goals.for.average.total")) || 1.4;
  let λa = Number(get(statsAway,"goals.for.average.away")) || Number(get(statsAway,"goals.for.average.total")) || 1.2;
  λh = Math.max(0.2, Math.min(3.5, λh));
  λa = Math.max(0.2, Math.min(3.5, λa));
  return { λh, λa };
}
function modelBTTS(λh, λa){
  const p0h = Math.exp(-λh);
  const p0a = Math.exp(-λa);
  const pBoth0 = Math.exp(-(λh+λa));
  const yes = 1 - p0h - p0a + pBoth0;
  return { Yes: Math.max(0, Math.min(1, yes)), No: Math.max(0, Math.min(1, 1-yes)) };
}
function modelOver25(λh, λa){
  const λ = λh + λa;
  const pUnderOrEq2 = poissonCDF(2, λ);
  const over = Math.max(0, Math.min(1, 1 - pUnderOrEq2));
  return { Over: over, Under: 1 - over, line: 2.5 };
}

// movement snapshot (per market+selection)
function movementPP(fxId, market, sel, oddsVal){
  const implied = impliedFromDecimal(oddsVal);
  if(!Number.isFinite(implied)) return 0;
  const key = `${fxId}|${market}|${sel}`;
  const prev = CACHE.oddsSnapshots.get(key);
  CACHE.oddsSnapshots.set(key, { ts: Date.now(), implied });
  if(!prev || !Number.isFinite(prev.implied)) return 0;
  const pp = (implied - prev.implied) * 100; // percentage points
  return Math.round(pp * 100) / 100;
}

function explainBlock(v){
  const bits=[];
  if(v.form_text) bits.push(`Forma: ${v.form_text}`);
  if(v.h2h_summary) bits.push(`H2H: ${v.h2h_summary}`);
  if(v.lineups_status==="confirmed") bits.push("Postave potvrđene");
  if(Number.isFinite(v.injuries_count)&&v.injuries_count>0) bits.push(`Povrede: ${v.injuries_count}`);
  if(Number.isFinite(v.movement_pct)&&v.movement_pct!==0) bits.push(`Tržište: ${v.movement_pct>0?"↑":"↓"} ${Math.abs(v.movement_pct).toFixed(2)}pp`);
  const summary=[
    Number.isFinite(v.edge_pp)?`Edge ${v.edge_pp.toFixed(1)}pp`:null,
    Number.isFinite(v.model_prob)?`Model ${Math.round(v.model_prob*100)}%`:null,
    v.market ? `Market ${v.market_label||v.market}` : null
  ].filter(Boolean).join(" · ");
  return { summary, bullets: bits };
}

function overallConfidence(v){
  const hasOdds = Number.isFinite(v.odds_dec) && Number.isFinite(v.implied_prob);
  const pPred=v.model_prob||0;
  const edge=Number.isFinite(v.edge_pp)? Math.max(-15, Math.min(15, v.edge_pp)) / 100 : 0; // pp -> fraction
  const form=v.form_score||0;
  const lineups=v.lineups_status==="confirmed"?1:(v.lineups_status==="expected"?0.6:0.4);
  const injuries=Math.max(0,1-Math.min(1,(v.injuries_count||0)/5));
  const move=Math.max(0,1+(v.movement_pct||0)/10);

  const W = hasOdds
    ? { pred:0.30, edge:0.22, form:0.15, h2h:0.08, lineups:0.10, inj:0.08, move:0.07 }
    : { pred:0.38, edge:0.06, form:0.20, h2h:0.12, lineups:0.12, inj:0.10, move:0.02 };

  const base = W.pred*pPred + W.edge*(0.5+edge) + W.form*form + W.h2h*(v.h2h_score||0) + W.lineups*(lineups/1.1) + W.inj*injuries + W.move*Math.min(1.2,move);
  const score = Math.max(0, Math.min(1, hasOdds ? base : base - 0.03));
  return score;
}

function formatPickForUI(base, pick){
  // pick = { market, selection, model_prob, odds_dec, implied_prob, edge_pp, ev, movement_pct, market_label }
  const conf = overallConfidence({ ...base, ...pick });
  const confidence_pct = Math.round(conf * 100);
  return {
    fixture_id: base.fx, teams: base.teams, league: base.league,
    datetime_local: { starting_at: { date_time: base.kickoffISO } },
    market: pick.market,
    market_label: pick.market_label,
    selection: pick.selection,
    type: Number.isFinite(pick.odds_dec) ? "MODEL+ODDS" : "FALLBACK",
    model_prob: pick.model_prob ?? null,
    market_odds: Number.isFinite(pick.odds_dec) ? pick.odds_dec : null,
    implied_prob: Number.isFinite(pick.implied_prob) ? pick.implied_prob : null,
    edge: Number.isFinite(pick.edge_pp) ? pick.edge_pp/100 : null, // keep edge (fraction) for legacy UI bits
    edge_pp: Number.isFinite(pick.edge_pp) ? pick.edge_pp : null,
    ev: Number.isFinite(pick.ev) ? pick.ev : null,
    movement_pct: Number.isFinite(pick.movement_pct) ? pick.movement_pct : 0,
    confidence_pct,
    confidence_bucket: bucketFromPct(confidence_pct),
    _score: confidence_pct,
    form_score: base.form_score,
    form_text: base.form_text,
    h2h_summary: base.h2h_summary,
    lineups_status: base.lineups_status,
    injuries_count: base.injuries_count,
    bookmakers_count: base.bookmakers_count || 0,
    explain: explainBlock({ ...base, ...pick, model_prob: pick.model_prob }),
  };
}

export default async function handler(req, res){
  const debug = req.query.debug === "1" || req.query.debug === "true";
  const t0 = Date.now();

  // 1) fixtures u rolling 24h
  let fixtures=[]; try{ fixtures=await fetchFixturesRolling(new Date()); }catch(_){}
  const out=[];

  for(const f of fixtures){
    const fx=f.fixture_id, leagueId=f.league?.id, season=f.league?.season, homeId=f.teams?.home?.id, awayId=f.teams?.away?.id;
    if(f.source!=="AF"){ // fallback bez AF ID-jeva -> samo minimal (da ne zatrpamo)
      const fallback = {
        fx, teams:f.teams, league:f.league,
        kickoffISO: sanitizeIso(f?.datetime_local?.starting_at?.date_time),
        form_score: 0.5, form_text: "", h2h_summary: "",
        lineups_status: "unknown", injuries_count: 0, bookmakers_count: 0,
      };
      const p = num(process.env.FALLBACK_MIN_PROB, 0.52);
      const pick = { market:"1X2", selection:"1", model_prob:p, odds_dec:null, implied_prob:null, edge_pp:null, ev:null, movement_pct:0, market_label:"1X2" };
      out.push(formatPickForUI(fallback, pick));
      continue;
    }

    // 2) stats + preds + odds
    let preds=null; if(withinBudget(1)) preds=await fetchPredictions(fx).catch(()=>null);
    let statsHome=null, statsAway=null;
    if(withinBudget(2) && leagueId && season){
      [statsHome,statsAway]=await Promise.all([
        fetchTeamStats(leagueId,season,homeId).catch(()=>null),
        fetchTeamStats(leagueId,season,awayId).catch(()=>null),
      ]);
    }
    const { λh, λa } = poissonLambdas(statsHome,statsAway);

    let oddsPack=null; if(withinBudget(1)) oddsPack=await fetchOdds(fx).catch(()=>null);
    const { odds, bookmakers_count } = oddsPack || {};

    // 3) form/h2h
    const form = (()=>{ const fscore = (stats)=>{ const s=stats?.form || stats?.fixtures?.form || ""; if(!s) return null; const map={W:1,D:0.5,L:0}; const v=s.toString().slice(-5).split("").map(c=>map[c]??0); return v.length? v.reduce((a,b)=>a+b,0)/v.length : null; }; const sh=fscore(statsHome), sa=fscore(statsAway); const text=(statsHome?.form||statsHome?.fixtures?.form||"")&&(statsAway?.form||statsAway?.fixtures?.form||"") ? `${(statsHome?.form||statsHome?.fixtures?.form||"").slice(-5)} vs ${(statsAway?.form||statsAway?.fixtures?.form||"").slice(-5)}` : ""; return { score: (sh==null||sa==null)?0.5:Math.max(0,Math.min(1,0.5+(sh-sa)/2)), text };})();
    const h2h = withinBudget(1) ? await fetchH2H(homeId,awayId,AF.H2H_LAST).catch(()=>({summary:"",count:0})) : {summary:"",count:0};

    // 4) near-kickoff extras
    let injuries_count=0, lineups_status="unknown";
    const kickoffISO=sanitizeIso(f?.datetime_local?.starting_at?.date_time);
    const minsTo = kickoffISO ? Math.round((new Date(kickoffISO).getTime()-Date.now())/60000) : null;
    if(minsTo!==null && minsTo<=AF.NEAR_WINDOW_MIN && minsTo>=-180){
      if(withinBudget(2)){
        const [inj,lin]=await Promise.all([
          fetchInjuries(fx).catch(()=>({count:0})),
          fetchLineups(fx).catch(()=>({status:"unknown"})),
        ]);
        injuries_count=inj.count||0; lineups_status=lin.status||"unknown";
      }
    }

    const base = {
      fx, teams:f.teams, league:f.league,
      kickoffISO, form_score:form.score, form_text:form.text, h2h_summary:h2h.summary,
      lineups_status, injuries_count, bookmakers_count: Number(bookmakers_count)||0
    };

    // 5) market candidates
    const candidates = [];

    // 1X2 (model = AF preds, ako postoje; inače slab fallback)
    if(preds){
      const pick = pickFromPreds(preds);
      const p = pick.prob;
      const sel = pick.selection;
      const o = odds?.["1X2"]?.[sel] ?? null;
      const imp = impliedFromDecimal(o);
      const edge_pp = (Number.isFinite(imp) ? (p - imp)*100 : null);
      const ev = Number.isFinite(o) ? evFrom(p, o) : null;
      const move = Number.isFinite(o) ? movementPP(fx, "1X2", sel, o) : 0;
      candidates.push({ market:"1X2", market_label:"1X2", selection:sel, model_prob:p, odds_dec:o, implied_prob:imp, edge_pp, ev, movement_pct:move });
    }

    // BTTS Yes/No (Poisson)
    {
      const btts = modelBTTS(λh, λa);
      const yesO = odds?.["BTTS"]?.["Yes"] ?? null;
      const noO  = odds?.["BTTS"]?.["No"]  ?? null;
      const yesImp = impliedFromDecimal(yesO);
      const noImp  = impliedFromDecimal(noO);

      const pushCandidate = (sel, p, o, imp) => {
        const edge_pp = Number.isFinite(imp) ? (p - imp)*100 : null;
        const ev = Number.isFinite(o) ? evFrom(p, o) : null;
        const move = Number.isFinite(o) ? movementPP(fx, "BTTS", sel, o) : 0;
        candidates.push({ market:"BTTS", market_label:"BTTS", selection:sel, model_prob:p, odds_dec:o, implied_prob:imp, edge_pp, ev, movement_pct:move });
      };
      // biramo bolju stranu samo ako ima neku kvotu (ili obe)
      if(yesO || noO){
        if(yesO) pushCandidate("Yes", btts.Yes, yesO, yesImp);
        if(noO)  pushCandidate("No",  btts.No,  noO,  noImp);
      }
    }

    // Over 2.5 (Poisson)
    {
      const ou = modelOver25(λh, λa); // {Over, Under, line:2.5}
      const key="2.5";
      const overO = odds?.["OU"]?.[key]?.["Over"] ?? null;
      const underO= odds?.["OU"]?.[key]?.["Under"] ?? null;
      const overImp = impliedFromDecimal(overO);
      const underImp= impliedFromDecimal(underO);

      const pushCandidate = (sel, p, o, imp) => {
        const edge_pp = Number.isFinite(imp) ? (p - imp)*100 : null;
        const ev = Number.isFinite(o) ? evFrom(p, o) : null;
        const move = Number.isFinite(o) ? movementPP(fx, "OU2.5", sel, o) : 0;
        const label = sel === "Over" ? "Over 2.5" : "Under 2.5";
        candidates.push({ market:"OU2.5", market_label:label, selection:sel, model_prob:p, odds_dec:o, implied_prob:imp, edge_pp, ev, movement_pct:move });
      };
      if(overO || underO){
        if(overO)  pushCandidate("Over",  ou.Over,  overO,  overImp);
        if(underO) pushCandidate("Under", ou.Under, underO, underImp);
      }
    }

    // Ako baš nema kvota ni za jedan market -> zadrži bar 1X2 fallback na 0.52
    if(candidates.length===0){
      const p = num(process.env.FALLBACK_MIN_PROB, 0.52);
      candidates.push({ market:"1X2", market_label:"1X2", selection:"1", model_prob:p, odds_dec:null, implied_prob:null, edge_pp:null, ev:null, movement_pct:0 });
    }

    // 6) odaberi "best" market:
    // prioritet: (a) najveći EV (ako imamo kvote), (b) edge_pp, (c) model_prob
    const best = candidates.slice().sort((a,b)=>{
      const aHasOdds = Number.isFinite(a.odds_dec), bHasOdds = Number.isFinite(b.odds_dec);
      if(aHasOdds!==bHasOdds) return bHasOdds - aHasOdds;
      const evA = Number.isFinite(a.ev) ? a.ev : -Infinity;
      const evB = Number.isFinite(b.ev) ? b.ev : -Infinity;
      if(evA !== evB) return evB - evA;
      const eA = Number.isFinite(a.edge_pp) ? a.edge_pp : -Infinity;
      const eB = Number.isFinite(b.edge_pp) ? b.edge_pp : -Infinity;
      if(eA !== eB) return eB - eA;
      return (b.model_prob||0) - (a.model_prob||0);
    })[0];

    out.push(formatPickForUI(base, best));
  }

  // rangiranje: MODEL+ODDS ispred FALLBACK-a, pa po _score
  out.sort((a,b)=>{
    if(a.type!==b.type) return a.type==="MODEL+ODDS"?-1:1;
    if(b._score!==a._score) return b._score-a._score;
    const ea = Number.isFinite(a.edge_pp)?a.edge_pp:-999, eb = Number.isFinite(b.edge_pp)?b.edge_pp:-999;
    return eb - ea;
  });

  const top = out.slice(0,10);

  const payload = {
    generated_at: new Date().toISOString(),
    tz_display: TZ,
    value_bets: top,
    _meta: debug ? { total_candidates: fixtures.length, counters: CACHE.counters, took_ms: Date.now()-t0 } : undefined,
  };
  res.setHeader("Cache-Control","s-maxage=60, stale-while-revalidate=60");
  res.status(200).json(payload);
}
