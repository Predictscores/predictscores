// FILE: pages/api/value-bets.js
/**
 * Value Bets (odds-only)
 * - Rolling 24h (Europe/Belgrade)
 * - Markets: 1X2, BTTS, Over/Under 2.5
 * - TWO-PASS:
 *    Pass1 (cheap): AF /predictions za sve AF fixtur-e -> shortlist po model_prob
 *    Pass2 (deep): za Top K -> AF /odds + /teams/statistics (home+away) + /h2h + (near kickoff) lineups/injuries
 * - Vraćamo SAMO predloge sa realnim kvotama (MODEL+ODDS). Parovi bez kvota se uklanjaju iz izlaza.
 * - In-flight dedup & 60s in-memory memo + CDN cache 600s.
 */

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_KEY = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY_1 || process.env.API_FOOTBALL_KEY_2 || "";
const SM_KEY = process.env.SPORTMONKS_KEY || "";
const FD_KEY = process.env.FOOTBALL_DATA_KEY || "";

const CFG = {
  BUDGET_DAILY: num(process.env.AF_BUDGET_DAILY, 5000),
  ROLLING_WINDOW_HOURS: num(process.env.AF_ROLLING_WINDOW_HOURS, 24),
  H2H_LAST: num(process.env.AF_H2H_LAST, 10),
  NEAR_WINDOW_MIN: num(process.env.AF_NEAR_WINDOW_MIN, 60),
  DEEP_TOP: num(process.env.AF_DEEP_TOP, 30),            // ⬆️ 20 -> 30
  RUN_HARDCAP: num(process.env.AF_RUN_MAX_CALLS, 180),   // blago pojačano
  PAYLOAD_MEMO_MS: 60 * 1000,                            // 60s in-memory memo
  CDN_SMAXAGE: num(process.env.CDN_SMAXAGE_SEC, 600),    // 10min
  CDN_SWR: num(process.env.CDN_STALE_SEC, 120)
};

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// ---------- global caches ----------
const g = globalThis;
if (!g.__VB_CACHE__) {
  g.__VB_CACHE__ = {
    byKey: new Map(),
    counters: { day: todayYMD(), apiFootball: 0, sportMonks: 0, footballData: 0 },
    snapshots: new Map(),
    inflight: null,
    inflightAt: 0,
    lastPayload: null,
  };
}
const CACHE = g.__VB_CACHE__;
function todayYMD(){ return new Date().toISOString().slice(0,10); }
function resetCountersIfNewDay(){
  const d = todayYMD();
  if (CACHE.counters.day !== d) {
    CACHE.counters = { day: d, apiFootball: 0, sportMonks: 0, footballData: 0 };
  }
}
function inc(name){ resetCountersIfNewDay(); CACHE.counters[name] = (CACHE.counters[name] || 0) + 1; }
function withinDailyBudget(incr=1){ resetCountersIfNewDay(); return CACHE.counters.apiFootball + incr <= CFG.BUDGET_DAILY; }
function setCache(k, data, ttlSec=60){ CACHE.byKey.set(k,{data,exp:Date.now()+ttlSec*1000}); return data; }
function getCache(k){ const it=CACHE.byKey.get(k); if(!it) return null; if(Date.now()>it.exp){ CACHE.byKey.delete(k); return null; } return it.data; }

// --- per-run hardcap ---
let RUN_CALLS = 0;
function canCallAF(qty=1){ return RUN_CALLS + qty <= CFG.RUN_HARDCAP; }
function noteAF(qty=1){ RUN_CALLS += qty; }

// ---------- helpers ----------
function sanitizeIso(s){ if(!s||typeof s!=="string") return null; let iso=s.trim().replace(" ","T"); iso=iso.replace("+00:00Z","Z").replace("Z+00:00","Z"); return iso; }
function impliedFromDecimal(o){ const x=Number(o); return Number.isFinite(x)&&x>1.01?1/x:null; }
function evFrom(p, o){ const odds=Number(o); if(!Number.isFinite(odds)||odds<=1.01) return null; return p*(odds-1) - (1-p); }
function toLocalYMD(d, tz){ return new Intl.DateTimeFormat("sv-SE",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d); }
function bucketFromPct(p){ if(p>=90) return "TOP"; if(p>=75) return "High"; if(p>=50) return "Moderate"; return "Low"; }
const sum = (a)=>a.reduce((x,y)=>x+y,0);
const median = (arr)=> arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)] : null;

// --- Poisson (za BTTS/OU2.5)
function poissonPMF(k, lambda){ if(lambda<=0) return k===0?1:0; let logP = -lambda; for(let i=1;i<=k;i++) logP += Math.log(lambda) - Math.log(i); return Math.exp(logP); }
function poissonCDF(k, lambda){ let acc=0; for(let i=0;i<=k;i++) acc+=poissonPMF(i,lambda); return acc; }

// ---------- HTTP wrappers ----------
async function afFetch(path,{ttl=0}={}){
  if(!AF_KEY) throw new Error("API_FOOTBALL_KEY missing");
  const url=`https://v3.football.api-sports.io${path}`;
  const ck=`AF:${url}`;
  if(ttl){ const c=getCache(ck); if(c) return c; }
  if(!withinDailyBudget()) throw new Error("AF budget exhausted");
  if(!canCallAF()) throw new Error("AF run hardcap reached");
  const res=await fetch(url,{headers:{ "x-apisports-key":AF_KEY }});
  noteAF(); inc("apiFootball");
  if(!res.ok) throw new Error(`AF ${path} -> ${res.status}`);
  const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j;
}
async function smFetch(url,{ttl=0}={}){ const ck=`SM:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; } const res=await fetch(url); inc("sportMonks"); if(!res.ok) throw new Error(`SM ${url} -> ${res.status}`); const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j; }
async function fdFetch(path,{ttl=0}={}){ const url=`https://api.football-data.org/v4${path}`; const ck=`FD:${url}`; if(ttl){ const c=getCache(ck); if(c) return c; } const res=await fetch(url,{headers:{ "X-Auth-Token":FD_KEY }}); inc("footballData"); if(!res.ok) throw new Error(`FD ${path} -> ${res.status}`); const j=await res.json(); if(ttl) setCache(ck,j,ttl); return j; }

// ---------- fetchers ----------
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
  const half = Math.max(1, Math.round(CFG.ROLLING_WINDOW_HOURS/2));
  const startMs = nowUTC.getTime() - half*3600*1000;
  const endMs   = nowUTC.getTime() + half*3600*1000;

  const tz=TZ;
  const dNow=new Date(nowUTC);
  const dPrev=new Date(nowUTC); dPrev.setDate(dPrev.getDate()-1);
  const dNext=new Date(nowUTC); dNext.setDate(dNext.getDate()+1);

  const days=[toLocalYMD(dPrev,tz), toLocalYMD(dNow,tz), toLocalYMD(dNext,tz)];
  let list=[];
  for(const ymd of days){ try{ list=list.concat(await fetchAFByDate(ymd)); }catch(_){} }

  const inWindow=list.filter(f=>{
    const iso=sanitizeIso(f?.datetime_local?.starting_at?.date_time);
    if(!iso) return false;
    const t=new Date(iso).getTime();
    return Number.isFinite(t)&&t>=startMs&&t<=endMs;
  });

  if(inWindow.length) return inWindow;

  // fallback (da UI ne bude prazan)
  try{
    if(SM_KEY){
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
    } else if(FD_KEY){
      const ymd=toLocalYMD(dNow,tz);
      const fd=await fdFetch(`/matches?dateFrom=${ymd}&dateTo=${ymd}`,{ttl:15*60});
      return (fd?.matches||[]).map(m=>({
        source:"FD",
        fixture_id:m?.id,
        league:{ id:m?.competition?.id, name:m?.competition?.name, country:"", season:m?.season?.startDate?.slice(0,4) },
        teams:{ home:{ id:m?.homeTeam?.id, name:m?.homeTeam?.name }, away:{ id:m?.awayTeam?.id, name:m?.awayTeam?.name } },
        datetime_local:{ starting_at:{ date_time:sanitizeIso(m?.utcDate) } },
      }));
    }
  }catch(_){}

  return [];
}

async function fetchPredictions(fx){
  const j=await afFetch(`/predictions?fixture=${fx}`,{ttl:30*60});
  const r=j?.response?.[0]; const preds=r?.predictions||r;
  let p1=preds?.percent?.home, px=preds?.percent?.draw, p2=preds?.percent?.away;
  const clean=v=>typeof v==="string"?parseFloat(v)/100:Number(v);
  p1=clean(p1); px=clean(px); p2=clean(p2);
  const t=[p1,px,p2].filter(Number.isFinite).reduce((a,b)=>a+b,0);
  if(t>0){ p1=(p1||0)/t; px=(px||0)/t; p2=(p2||0)/t; return {p1,px,p2}; }
  return null;
}

function leaguePriority(leagueName="") {
  const s = leagueName.toLowerCase();
  // top: UCL, UEL, top 5, top 10
  if (/(champions league|europa|premier league|la liga|bundesliga|serie a|ligue 1|eredivisie|primeira|mls)/i.test(s)) return 0;
  if (/(super league|superliga|first division|j1|liga profesional|liga mx)/i.test(s)) return 1;
  if (/(u23|reserves|ii|b team|next pro|youth|academy)/i.test(s)) return 3;
  return 2;
}

/**
 * Popravljeni aggregator: prolazimo KROZ SVE BOOKMAKERE i skupljamo kvote,
 * pa računamo median po marketu.
 */
async function fetchOdds(fx){
  const j=await afFetch(`/odds?fixture=${fx}`,{ttl:10*60});
  const resp=j?.response||[];

  const acc = {
    "1X2": { "1":[], "X":[], "2":[] },
    "BTTS": { "Yes":[], "No":[] },
    "OU": {} // key "2.5": {Over:[], Under:[]}
  };
  let bookmakersUsed = 0;

  for(const row of resp){
    const books = row?.bookmakers || [];
    for (const bm of books) {
      const bets = bm?.bets || [];
      let usedThisBook = false;

      for (const bet of bets) {
        const name = (bet?.name || "").toLowerCase();

        // 1X2 varijante
        if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
          for (const v of (bet?.values||[])) {
            const lbl = (v?.value||"").toUpperCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl==="HOME"||lbl==="1") acc['1X2']["1"].push(odd), usedThisBook = true;
            if (lbl==="DRAW"||lbl==="X") acc['1X2']["X"].push(odd), usedThisBook = true;
            if (lbl==="AWAY"||lbl==="2") acc['1X2']["2"].push(odd), usedThisBook = true;
          }
        }

        // BTTS
        if (name.includes("both teams to score") || name.includes("btts")) {
          for (const v of (bet?.values||[])) {
            const lbl=(v?.value||"").toLowerCase();
            const odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if(lbl.includes("yes")) acc['BTTS'].Yes.push(odd), usedThisBook=true;
            if(lbl.includes("no"))  acc['BTTS'].No.push(odd),  usedThisBook=true;
          }
        }

        // Over/Under (Total Goals)
        if (name.includes("over/under") || name.includes("goals over/under") || name.includes("totals") || name.includes("total goals")) {
          for (const v of (bet?.values||[])) {
            const lbl=(v?.value||"").toLowerCase(); // "Over 2.5"
            const odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            const parts=lbl.split(" ");
            const side=parts[0];
            const line=parseFloat(parts[1]);
            if(!Number.isFinite(line)) continue;
            const key=line.toFixed(1);
            if(!acc['OU'][key]) acc['OU'][key]={ Over:[], Under:[] };
            if(side.startsWith("over"))  acc['OU'][key].Over.push(odd), usedThisBook=true;
            if(side.startsWith("under")) acc['OU'][key].Under.push(odd), usedThisBook=true;
          }
        }
      }

      if (usedThisBook) bookmakersUsed++;
    }
  }

  const odds = {
    "1X2": { "1": median(acc['1X2']["1"]), "X": median(acc['1X2']["X"]), "2": median(acc['1X2']["2"]) },
    "BTTS": { "Yes": median(acc['BTTS'].Yes), "No": median(acc['BTTS'].No) },
    "OU": {}
  };
  for (const line of Object.keys(acc['OU'])) {
    odds["OU"][line] = { "Over": median(acc['OU'][line].Over), "Under": median(acc['OU'][line].Under) };
  }
  return { odds, bookmakers_count: bookmakersUsed };
}

async function fetchTeamStats(leagueId,season,teamId){
  const j=await afFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`,{ttl:12*3600});
  return j?.response||null;
}
async function fetchH2H(homeId,awayId,last){
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
}
async function fetchInjuries(fx){ try{ const j=await afFetch(`/injuries?fixture=${fx}`,{ttl:10*60}); return { count:(j?.response||[]).length||0 }; }catch(_){ return {count:0}; } }
async function fetchLineups(fx){ try{ const j=await afFetch(`/fixtures/lineups?fixture=${fx}`,{ttl:5*60}); const ln=j?.response||[]; const confirmed=ln.some(x=>Array.isArray(x?.startXI)&&x.startXI.length>0); return { status: confirmed ? "confirmed" : (ln.length ? "expected" : "unknown") }; }catch(_){ return {status:"unknown"}; } }

// --- models
function pickFromPreds(preds){ const map={ "1":preds?.p1||0, "X":preds?.px||0, "2":preds?.p2||0 }; const sel=Object.keys(map).sort((a,b)=>map[b]-map[a])[0]||"1"; return { selection:sel, prob: map[sel]||0 }; }
function poissonLambdas(statsHome, statsAway){
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

function movementPP(fxId, market, sel, oddsVal){
  const implied = impliedFromDecimal(oddsVal);
  if(!Number.isFinite(implied)) return 0;
  const key = `${fxId}|${market}|${sel}`;
  const prev = CACHE.snapshots.get(key);
  CACHE.snapshots.set(key, { ts: Date.now(), implied });
  if(!prev || !Number.isFinite(prev.implied)) return 0;
  const pp = (implied - prev.implied) * 100;
  return Math.round(pp * 100) / 100;
}

function overallConfidence(v){
  // Sada se gotovo uvek radi sa kvotama, ali zadržavamo težine
  const hasOdds = Number.isFinite(v.odds_dec) && Number.isFinite(v.implied_prob);
  const pPred=v.model_prob||0;
  const edge=Number.isFinite(v.edge_pp)? Math.max(-15, Math.min(15, v.edge_pp)) / 100 : 0;
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

function formatPick(base, pick){
  const conf = overallConfidence({ ...base, ...pick });
  const confidence_pct = Math.round(conf * 100);
  return {
    fixture_id: base.fx, teams: base.teams, league: base.league,
    datetime_local: { starting_at: { date_time: base.kickoffISO } },
    market: pick.market, market_label: pick.market_label,
    selection: pick.selection,
    type: "MODEL+ODDS",
    model_prob: pick.model_prob ?? null,
    market_odds: Number.isFinite(pick.odds_dec) ? pick.odds_dec : null,
    implied_prob: Number.isFinite(pick.implied_prob) ? pick.implied_prob : null,
    edge: Number.isFinite(pick.edge_pp) ? pick.edge_pp/100 : null,
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

// ---------- main compute (two-pass with caps) ----------
async function computePayload(){
  RUN_CALLS = 0; // reset hardcap counter
  const t0 = Date.now();

  // 0) Fixtures
  let fixtures = await fetchFixturesRolling(new Date());

  // Blagi prioritet liga (top napred)
  fixtures.sort((a,b) => leaguePriority(a?.league?.name) - leaguePriority(b?.league?.name));

  const afFixtures = fixtures.filter(f => f.source === "AF");

  // 1) PASS 1: predictions (cheap)
  const pass1 = [];
  for (const f of afFixtures) {
    if (!canCallAF()) break;
    const preds = await fetchPredictions(f.fixture_id).catch(()=>null);
    let selection="1", model_prob = num(process.env.FALLBACK_MIN_PROB,0.52);
    if (preds) { const p = pickFromPreds(preds); selection=p.selection; model_prob=p.prob; }
    pass1.push({
      fx: f.fixture_id, league: f.league, teams: f.teams,
      kickoffISO: sanitizeIso(f?.datetime_local?.starting_at?.date_time),
      selection, model_prob,
      form_score: 0.5, form_text: "", h2h_summary: "",
      lineups_status: "unknown", injuries_count: 0, bookmakers_count: 0,
    });
  }

  // shortlist po model_prob
  const K = Math.max(5, Math.min(CFG.DEEP_TOP, pass1.length));
  const shortlist = pass1.slice().sort((a,b)=> (b.model_prob||0)-(a.model_prob||0)).slice(0, K);

  // 2) PASS 2: deep (odds + stats + h2h + near extras)
  const deepPicks = [];
  for (const base of shortlist) {
    const { fx, league, teams, kickoffISO } = base;

    // odds (agregator preko SVIH bookmakera)
    let oddsPack=null; if (canCallAF()) { oddsPack = await fetchOdds(fx).catch(()=>null); }
    const odds = oddsPack?.odds || null;
    const bookmakers_count = Number(oddsPack?.bookmakers_count || 0);

    // Ako NEMA kvota ni za jedan market -> SKIP (ne želimo model-only)
    const hasAnyOdds =
      Number.isFinite(odds?.["1X2"]?.["1"]) || Number.isFinite(odds?.["1X2"]?.["X"]) || Number.isFinite(odds?.["1X2"]?.["2"]) ||
      Number.isFinite(odds?.["BTTS"]?.["Yes"]) || Number.isFinite(odds?.["BTTS"]?.["No"]) ||
      Number.isFinite(odds?.["OU"]?.["2.5"]?.["Over"]) || Number.isFinite(odds?.["OU"]?.["2.5"]?.["Under"]);
    if (!hasAnyOdds) continue;

    // stats & h2h
    let statsHome=null, statsAway=null, h2h={summary:"",count:0};
    if (canCallAF(3) && league?.id && league?.season && teams?.home?.id && teams?.away?.id) {
      [statsHome, statsAway] = await Promise.all([
        fetchTeamStats(league.id, league.season, teams.home.id).catch(()=>null),
        fetchTeamStats(league.id, league.season, teams.away.id).catch(()=>null),
      ]);
      h2h = await fetchH2H(teams.home.id, teams.away.id, CFG.H2H_LAST).catch(()=>({summary:"",count:0}));
    }

    // form
    const form = (()=>{ const fscore = (s)=>{ const sform=s?.form || s?.fixtures?.form || ""; if(!sform) return null; const map={W:1,D:0.5,L:0}; const v=sform.toString().slice(-5).split("").map(c=>map[c]??0); return v.length? v.reduce((a,b)=>a+b,0)/v.length : null; }; const sh=fscore(statsHome), sa=fscore(statsAway); const text=(statsHome?.form||statsHome?.fixtures?.form||"")&&(statsAway?.form||statsAway?.fixtures?.form||"") ? `${(statsHome?.form||statsHome?.fixtures?.form||"").slice(-5)} vs ${(statsAway?.form||statsAway?.fixtures?.form||"").slice(-5)}` : ""; return { score: (sh==null||sa==null)?0.5:Math.max(0,Math.min(1,0.5+(sh-sa)/2)), text };})();

    // near-kickoff extras
    let injuries_count=0, lineups_status="unknown";
    const minsTo = kickoffISO ? Math.round((new Date(kickoffISO).getTime()-Date.now())/60000) : null;
    if (minsTo!==null && minsTo<=CFG.NEAR_WINDOW_MIN && minsTo>=-180) {
      if (canCallAF(2)) {
        const [inj, lin] = await Promise.all([
          fetchInjuries(fx).catch(()=>({count:0})),
          fetchLineups(fx).catch(()=>({status:"unknown"})),
        ]);
        injuries_count = inj.count||0; lineups_status = lin.status||"unknown";
      }
    }

    // λ za Poisson
    const { λh, λa } = poissonLambdas(statsHome, statsAway);

    // kandidati — SAMO sa kvotama
    const candidates = [];

    // 1X2
    {
      const sel = base.selection;            // iz preds
      const p  = base.model_prob;
      const o  = odds?.["1X2"]?.[sel] ?? null;
      if (Number.isFinite(o)) {
        const imp = impliedFromDecimal(o);
        const edge_pp = (Number.isFinite(imp) ? (p - imp)*100 : null);
        const ev = evFrom(p, o);
        const move = movementPP(fx, "1X2", sel, o) || 0;
        candidates.push({ market:"1X2", market_label:"1X2", selection:sel, model_prob:p, odds_dec:o, implied_prob:imp, edge_pp, ev, movement_pct:move });
      }
    }

    // BTTS
    {
      const btts = modelBTTS(λh, λa);
      const yesO = odds?.["BTTS"]?.["Yes"] ?? null;
      const noO  = odds?.["BTTS"]?.["No"]  ?? null;
      if(Number.isFinite(yesO)){
        const yesImp = impliedFromDecimal(yesO);
        const edge_pp=(btts.Yes-yesImp)*100;
        const ev=evFrom(btts.Yes, yesO);
        const move=movementPP(fx,"BTTS","Yes",yesO);
        candidates.push({ market:"BTTS", market_label:"BTTS", selection:"Yes", model_prob:btts.Yes, odds_dec:yesO, implied_prob:yesImp, edge_pp, ev, movement_pct:move });
      }
      if(Number.isFinite(noO)){
        const noImp = impliedFromDecimal(noO);
        const edge_pp=(btts.No-noImp)*100;
        const ev=evFrom(btts.No, noO);
        const move=movementPP(fx,"BTTS","No",noO);
        candidates.push({ market:"BTTS", market_label:"BTTS", selection:"No", model_prob:btts.No, odds_dec:noO, implied_prob:noImp, edge_pp, ev, movement_pct:move });
      }
    }

    // OU 2.5
    {
      const ou = modelOver25(λh, λa);
      const overO = odds?.["OU"]?.["2.5"]?.["Over"] ?? null;
      const underO= odds?.["OU"]?.["2.5"]?.["Under"] ?? null;
      if(Number.isFinite(overO)){
        const overImp = impliedFromDecimal(overO);
        const edge_pp=(ou.Over-overImp)*100;
        const ev=evFrom(ou.Over,overO);
        const move=movementPP(fx,"OU2.5","Over",overO);
        candidates.push({ market:"OU2.5", market_label:"Over 2.5", selection:"Over", model_prob:ou.Over, odds_dec:overO, implied_prob:overImp, edge_pp, ev, movement_pct:move });
      }
      if(Number.isFinite(underO)){
        const underImp = impliedFromDecimal(underO);
        const edge_pp=(ou.Under-underImp)*100;
        const ev=evFrom(ou.Under,underO);
        const move=movementPP(fx,"OU2.5","Under",underO);
        candidates.push({ market:"OU2.5", market_label:"Under 2.5", selection:"Under", model_prob:ou.Under, odds_dec:underO, implied_prob:underImp, edge_pp, ev, movement_pct:move });
      }
    }

    // Ako nema nijednog kandidata sa kvotama -> SKIP
    if (!candidates.length) continue;

    // odabir najboljeg: EV, edge, model_prob
    const best = candidates.slice().sort((a,b)=>{
      const evA = Number.isFinite(a.ev)?a.ev:-Infinity;
      const evB = Number.isFinite(b.ev)?b.ev:-Infinity;
      if(evA!==evB) return evB-evA;
      const eA = Number.isFinite(a.edge_pp)?a.edge_pp:-Infinity;
      const eB = Number.isFinite(b.edge_pp)?b.edge_pp:-Infinity;
      if(eA!==eB) return eB-eA;
      return (b.model_prob||0)-(a.model_prob||0);
    })[0];

    deepPicks.push(formatPick({
      fx, teams, league, kickoffISO,
      form_score: form.score, form_text: form.text,
      h2h_summary: h2h.summary, lineups_status, injuries_count,
      bookmakers_count
    }, best));
  }

  // 3) (Nema više fallbacks bez kvota) → deepPicks je konačna lista

  // 4) rangiranje
  deepPicks.sort((a,b)=>{
    if(b._score!==a._score) return b._score-a._score;
    const ea = Number.isFinite(a.edge_pp)?a.edge_pp:-999;
    const eb = Number.isFinite(b.edge_pp)?b.edge_pp:-999;
    return eb - ea;
  });

  const top = deepPicks.slice(0, 40); // gornja granica za locked 25/backup 15

  return {
    generated_at: new Date().toISOString(),
    tz_display: TZ,
    value_bets: top,
    _meta: { total_candidates: fixtures.length, counters: CACHE.counters, run_calls: RUN_CALLS, took_ms: Date.now()-t0 }
  };
}

// ---------- API handler ----------
export default async function handler(req, res){
  const now = Date.now();

  // 60s in-memory memo (ignoriše query razlike)
  if (CACHE.lastPayload && (now - CACHE.lastPayload.ts) < CFG.PAYLOAD_MEMO_MS) {
    res.setHeader("Cache-Control", `s-maxage=${CFG.CDN_SMAXAGE}, stale-while-revalidate=${CFG.CDN_SWR}`);
    return res.status(200).json(CACHE.lastPayload.data);
  }

  if (CACHE.inflight) {
    try {
      const data = await CACHE.inflight;
      res.setHeader("Cache-Control", `s-maxage=${CFG.CDN_SMAXAGE}, stale-while-revalidate=${CFG.CDN_SWR}`);
      return res.status(200).json(data);
    } catch(_){/* fall through */}
  }

  const run = (async () => {
    try {
      const data = await computePayload();
      CACHE.lastPayload = { ts: Date.now(), data };
      return data;
    } finally {
      CACHE.inflight = null;
      CACHE.inflightAt = 0;
    }
  })();

  CACHE.inflight = run;
  CACHE.inflightAt = now;

  try {
    const data = await run;
    res.setHeader("Cache-Control", `s-maxage=${CFG.CDN_SMAXAGE}, stale-while-revalidate=${CFG.CDN_SWR}`);
    res.status(200).json(data);
  } catch (err) {
    console.warn("value-bets run error:", err?.message || err);
    res.status(500).json({ error: "value-bets failed" });
  }
}
