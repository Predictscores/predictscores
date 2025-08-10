// FILE: pages/api/value-bets.js
//
// Dnevni TOP value betovi (fudbal) sa API-FOOTBALL (plaćeni plan).
// - Fixtures + pre-match odds iz API-FOOTBALL (v3)
// - Keš: fixtures 2h, odds po-fixture 90min
// - Vraća do 10 predloga (MODEL+ODDS prioritet, pa FALLBACK)
// - Vremena prikazujemo u Europe/Belgrade
//
// Napomena: potrebna je env varijabla API_FOOTBALL_KEY

export const config = { api: { bodyParser: false } };

const AF_KEY = process.env.API_FOOTBALL_KEY || "";
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Pragovi (po želji možeš menjati kroz env):
const MIN_EDGE_STRICT = Number(process.env.MIN_EDGE_STRICT || "0.05");
const MIN_EDGE_WEAK   = Number(process.env.MIN_EDGE_WEAK   || "0.03");
const MIN_ODDS        = Number(process.env.MIN_ODDS        || "1.30");
const FALLBACK_STRICT_MIN = Number(process.env.FALLBACK_STRICT_MIN || "0.48");
const FALLBACK_WEAK_MIN   = Number(process.env.FALLBACK_WEAK_MIN   || "0.40");

const FIXTURES_CACHE_TTL = 2 * 60 * 60 * 1000;   // 2h
const ODDS_CACHE_TTL     = 90 * 60 * 1000;       // 90min
const MAX_FIXTURES_SCAN  = 40;                   // kol’ko fixture-a skeniramo za današnji dan

let _fixturesCache = { dateKey: null, data: null, ts: 0 };
const _oddsCacheByFixture = new Map(); // fixtureId -> {ts, odds:{home,draw,away}, bookies}

function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function toNumber(x, def=0){ const n=Number(x); return Number.isFinite(n)?n:def; }

function todayYMD(tz="UTC"){
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const [{value:y},, {value:m},, {value:d2}] = fmt.formatToParts(d);
  return `${y}-${m}-${d2}`;
}
function formatBelgradeDateTime(iso){
  try{
    if(!iso) return "";
    const d = new Date(iso);
    const fmtDate=new Intl.DateTimeFormat('en-CA',{timeZone:TZ_DISPLAY,year:'numeric',month:'2-digit',day:'2-digit'});
    const fmtTime=new Intl.DateTimeFormat('en-GB',{timeZone:TZ_DISPLAY,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const [{value:y},, {value:m},, {value:da}] = fmtDate.formatToParts(d);
    return `${y}-${m}-${da} ${fmtTime.format(d)}`;
  }catch{ return iso }
}
function confidenceBucket(p){
  if(p>=0.90) return "TOP";
  if(p>=0.75) return "High";
  if(p>=0.50) return "Moderate";
  return "Low";
}

// Ultra-lagan model (kad nema kvota) – stabilan fallback
function baseModel1X2Prob(){
  const homeAdv=0.12; let pH=0.45+homeAdv, pA=0.30-homeAdv/2, pD=0.25-homeAdv/2;
  const s=pH+pD+pA; return {home:pH/s, draw:pD/s, away:pA/s};
}
function impliedFromBestOdds(best){
  const invH=best.home?1/best.home:0, invD=best.draw?1/best.draw:0, invA=best.away?1/best.away:0;
  const s=invH+invD+invA; if(s<=0) return {home:0,draw:0,away:0};
  return {home:invH/s, draw:invD/s, away:invA/s};
}
function hoursUntil(iso){
  try{ return (new Date(iso).getTime()-Date.now())/3600000; }catch{ return 999; }
}
function scoreFromEdge(edge, bookies=0, hoursToKO=24){
  const e=clamp(edge,-1,1), b=clamp(bookies/10,0,1);
  const t = hoursToKO>=6?0.6:hoursToKO>=3?0.5:0.3;
  const score = 0.70*e + 0.20*b + 0.10*(1-Math.abs(t-0.45));
  return clamp((score+1)/2*100,0,100);
}

// ---------- API-FOOTBALL helpers ----------
async function afGet(path, params){
  if(!AF_KEY) return {ok:false,status:401,data:null};
  const qs = new URLSearchParams(params||{}).toString();
  const url = `https://v3.football.api-sports.io${path}${qs?`?${qs}`:""}`;
  const res = await fetch(url, { headers: { "x-apisports-key": AF_KEY, "accept":"application/json" }});
  const data = await res.json().catch(()=>null);
  return { ok: res.ok, status: res.status, data };
}

// Fixtures by date (u lokalnoj zoni da dobijemo lep datetime za prikaz)
async function fetchFixturesForDate(dateYMD){
  const cacheKey = dateYMD;
  if(_fixturesCache.dateKey===cacheKey && _fixturesCache.data && Date.now()-_fixturesCache.ts < FIXTURES_CACHE_TTL){
    return _fixturesCache.data;
  }
  const r = await afGet("/fixtures", { date: dateYMD, timezone: TZ_DISPLAY });
  const arr = Array.isArray(r?.data?.response) ? r.data.response : [];
  _fixturesCache = { dateKey: cacheKey, data: arr, ts: Date.now() };
  return arr;
}

// Odds (pre-match) za jedan fixture – skupljamo “best” 1X2 preko svih bookija
async function fetchBest1x2OddsForFixture(fixtureId){
  const cached = _oddsCacheByFixture.get(fixtureId);
  if(cached && Date.now()-cached.ts < ODDS_CACHE_TTL) return cached;

  const r = await afGet("/odds", { fixture: String(fixtureId) });
  const resp = Array.isArray(r?.data?.response) ? r.data.response : [];
  let best = { home:0, draw:0, away:0 }, bookies = 0;

  // Struktura: response[ { bookmakers: [ { name,id, bets:[ {name, values:[{value, odd}]} ] } ] } ]
  for(const bloc of resp){
    for(const bk of (bloc.bookmakers||[])){
      const bets = bk.bets || bk.markets || [];
      const matchWin = bets.find(b => /match\s*winner|1x2/i.test(b.name||""));
      if(!matchWin) continue;
      // values: [{value:"Home"|1, odd:"1.85"}, ...]
      const vals = matchWin.values || [];
      const get = (lbl) => {
        const v = vals.find(x => String(x.value||"").toLowerCase()===lbl) 
               || vals.find(x => String(x.value||"").trim()===lbl.toUpperCase());
        return v ? toNumber(v.odd,0) : 0;
      };
      const h = Math.max(get("home"), get("1"));
      const d = Math.max(get("draw"), get("x"));
      const a = Math.max(get("away"), get("2"));
      if(h) best.home = Math.max(best.home, h);
      if(d) best.draw = Math.max(best.draw, d);
      if(a) best.away = Math.max(best.away, a);
      bookies++;
    }
  }
  const packed = { ts: Date.now(), odds: best, bookies };
  _oddsCacheByFixture.set(fixtureId, packed);
  return packed;
}

// ------------------------------------------

export default async function handler(req, res){
  try{
    const url = new URL(req.url, "http://localhost");
    const date = url.searchParams.get("date") || todayYMD(TZ_DISPLAY);

    // 1) Uzmi sve današnje fixture-e (limitiramo koliko skeniramo)
    const fixtures = (await fetchFixturesForDate(date)).slice(0, MAX_FIXTURES_SCAN);

    const picksStrict = [], picksWeak = [];

    for(const f of fixtures){
      const fixtureId = f?.fixture?.id;
      const home = f?.teams?.home?.name || "Home";
      const away = f?.teams?.away?.name || "Away";
      const league = { id: f?.league?.id, name: f?.league?.name, country_id: f?.league?.country };
      const startISO = f?.fixture?.date; // već u TZ_DISPLAY zbog parametra timezone
      const belgrade = formatBelgradeDateTime(startISO);
      const hours = hoursUntil(startISO);
      if(hours < 0.33) continue; // <20min do početka

      const model = baseModel1X2Prob();

      // 2) Pokušaj da dobiješ kvote za ovaj fixture
      let type = "FALLBACK", marketOdds = null, implied = {home:0,draw:0,away:0}, bookies = 0;
      if(fixtureId){
        const got = await fetchBest1x2OddsForFixture(fixtureId);
        if(got && (got.odds.home||got.odds.draw||got.odds.away)){
          type = "MODEL+ODDS";
          marketOdds = got.odds;
          implied = impliedFromBestOdds(got.odds);
          bookies = toNumber(got.bookies,0);
        }
      }

      const edges = {
        home: model.home - implied.home,
        draw: model.draw - implied.draw,
        away: model.away - implied.away
      };
      let sel="home", selProb=model.home, selOdds=marketOdds?.home||null, selEdge=edges.home;
      if(edges.draw > selEdge){ sel="draw"; selProb=model.draw; selOdds=marketOdds?.draw||null; selEdge=edges.draw; }
      if(edges.away > selEdge){ sel="away"; selProb=model.away; selOdds=marketOdds?.away||null; selEdge=edges.away; }

      const hasOdds = (type === "MODEL+ODDS");
      const passStrict = hasOdds ? (selEdge>=MIN_EDGE_STRICT && toNumber(selOdds,0)>=MIN_ODDS && bookies>=3)
                                 : (selProb>=FALLBACK_STRICT_MIN);
      const passWeak   = hasOdds ? (selEdge>=MIN_EDGE_WEAK   && toNumber(selOdds,0)>=MIN_ODDS)
                                 : (selProb>=FALLBACK_WEAK_MIN);

      const score = scoreFromEdge(selEdge, bookies, hours);
      const selectionLabel = sel==='home'?'1':sel==='draw'?'X':'2';
      const confPct = Math.round(selProb*100);

      const pick = {
        fixture_id: fixtureId,
        market: "1X2",
        selection: selectionLabel,
        type,
        model_prob: selProb,
        market_odds: hasOdds ? selOdds : null,
        edge: hasOdds ? selEdge : null,
        datetime_local: { starting_at: { date_time: belgrade } },
        teams: { home: { name: home }, away: { name: away } },
        league,
        confidence_pct: confPct,
        confidence_bucket: confidenceBucket(selProb),
        _score: score,
      };

      if(passStrict) picksStrict.push(pick);
      else if(passWeak) picksWeak.push(pick);
    }

    picksStrict.sort((a,b)=>toNumber(b._score,0)-toNumber(a._score,0));
    picksWeak.sort((a,b)=>toNumber(b._score,0)-toNumber(a._score,0));

    const desired = 10;
    const out = [...picksStrict.slice(0, desired)];
    if(out.length<desired){
      const seen = new Set(out.map(x=>x.fixture_id));
      for(const w of picksWeak){
        if(out.length>=desired) break;
        if(seen.has(w.fixture_id)) continue;
        out.push(w); seen.add(w.fixture_id);
      }
    }

    res.setHeader("Cache-Control","s-maxage=1800, stale-while-revalidate=1800"); // 30min
    return res.status(200).json({ value_bets: out, generated_at: new Date().toISOString() });

  }catch(err){
    console.error("value-bets fatal", err?.message||err);
    res.setHeader("Cache-Control","s-maxage=300, stale-while-revalidate=300");
    return res.status(200).json({ value_bets: [], note: "error, returned empty" });
  }
}
