// FILE: pages/api/value-bets.js
//
// V2 model u ISTOM endpointu (bez novih fajlova) — maksimalno koliko možemo sada:
// - Fixtures (više strategija: status/zone/from-to) -> uzmi do `max` mečeva (default 30)
// - Poisson + blaga Dixon–Coles korekcija (λ iz teams/statistics, home/away odvojeno)
// - Standings (pozicije), recent form (last 5), H2H (last 5) -> male korekcije
// - API-Football odds po fixture-u (ako tvoj plan ima ODDS; fallback ako nema)
// - Selektor: ako ima kvota -> EV filter; uvek vraćamo do 10 pickova
// - Sve sa jednostavnim in-memory kešom da ne trošimo previše poziva
//
// ENV (Vercel Project Settings -> Environment Variables):
//   API_FOOTBALL_KEY               (obavezno)
//   TZ_DISPLAY=Europe/Belgrade     (opciono; default Europe/Belgrade)
//   V2_MAX_FIXTURES=30             (opciono; default 30 za ovaj endpoint)
//   V2_MIN_EV=0.03                 (opciono; min EV kada imamo kvote; default 0.03 = 3%)
//   V2_BOOKIES_MIN=6               (opciono; min broj kladionica kada imamo kvote; default 6)
//   V2_SHRINK_ALPHA=0.65           (opciono; 0..1; koliko „stišavamo“ ekstremne verovatnoće)
//   V2_RHO=-0.1                    (opciono; DC korekcija niskih rezultata; blaga)
//   V2_CACHE_TTL_BASE=10800        (sekunde; 3h default)
//   NOTE: Ako tvoj plan nema odds, ovaj kod i dalje radi (type: "FALLBACK").
//
// UI kompatibilnost: zadržavamo ista polja (market, selection, model_prob, market_odds?, type, league, datetime_local, teams, confidence_pct, confidence_bucket, _score).

export const config = { api: { bodyParser: false } };

// ---------- ENV & TUNING ----------
const APIF_KEY        = process.env.API_FOOTBALL_KEY || "";
const TZ_DISPLAY      = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MAX_FIXTURES    = toNum(process.env.V2_MAX_FIXTURES, 30);
const MIN_EV          = toNum(process.env.V2_MIN_EV, 0.03);
const BOOKIES_MIN     = toNum(process.env.V2_BOOKIES_MIN, 6);
const SHRINK_ALPHA    = clamp(toNum(process.env.V2_SHRINK_ALPHA, 0.65), 0, 1);
const DC_RHO          = clamp(toNum(process.env.V2_RHO, -0.1), -0.3, 0.3);
const BASE_TTL_SEC    = Math.max(600, toNum(process.env.V2_CACHE_TTL_BASE, 10800)); // min 10 min

// TTL (ms)
const TTL_STANDINGS = BASE_TTL_SEC * 1000;
const TTL_STATS     = BASE_TTL_SEC * 1000;
const TTL_FORM      = (BASE_TTL_SEC/2) * 1000;
const TTL_H2H       = BASE_TTL_SEC * 1000;
const TTL_ODDS      = (BASE_TTL_SEC/3) * 1000;

// Liga prior (fallback kada je malo podataka)
const PRIOR_DRAW    = 0.26;    // tipična liga draw stopa
const PRIOR_HOME    = 0.07;    // bazni home edge

// ---------- IN-MEMORY CACHE ----------
const standingsCache = new Map(); // `${league}-${season}` -> {fetchedAt, table}
const teamStatsCache = new Map(); // `${team}-${league}-${season}` -> {fetchedAt, stats}
const formCache      = new Map(); // `team-${id}-${season}` -> {fetchedAt, form}
const h2hCache       = new Map(); // `h2h-${home}-${away}` -> {fetchedAt, stats}
const oddsCache      = new Map(); // `fixture-${id}` -> {fetchedAt, best, bookies}

// ---------- HELPERS ----------
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function toNum(x, def=0){
  if (x === null || x === undefined || x === "") return def;
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function todayYMD(tz="UTC"){
  const d=new Date();
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const [{value:y},, {value:m},, {value:da}] = fmt.formatToParts(d);
  return `${y}-${m}-${da}`;
}
function formatLocal(isoUtcLike){
  try{
    if(!isoUtcLike) return "";
    const iso = isoUtcLike.endsWith('Z')? isoUtcLike : (isoUtcLike + 'Z');
    const d = new Date(iso);
    const dateFmt = new Intl.DateTimeFormat('en-CA',{timeZone:TZ_DISPLAY,year:'numeric',month:'2-digit',day:'2-digit'});
    const timeFmt = new Intl.DateTimeFormat('en-GB',{timeZone:TZ_DISPLAY,hour:'2-digit',minute:'2-digit',hour12:false});
    const [{value:y},, {value:m},, {value:dd}] = dateFmt.formatToParts(d);
    return `${y}-${m}-${dd} ${timeFmt.format(d)}`;
  }catch{return isoUtcLike}
}
function bucketFromPct(p){
  if(p>=90) return "TOP";
  if(p>=75) return "High";
  if(p>=50) return "Moderate";
  return "Low";
}
function shrink(p, alpha=SHRINK_ALPHA){
  return 0.5 + alpha*(p-0.5);
}

// API-Football fetch wrapper
async function afetch(path, params = {}){
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(params).forEach(([k,v]) => { if(v!=null) url.searchParams.set(k, String(v)); });
  const res = await fetch(url, { headers: { 'x-apisports-key': APIF_KEY }});
  let json={};
  try{ json = await res.json(); }catch{}
  if(!res.ok){
    const err = new Error(`API-Football ${path} ${res.status}`);
    err.status = res.status; err.payload = json;
    throw err;
  }
  return json;
}

// ---------- FIXTURES (multi-strategy) ----------
async function fetchFixturesForDate(date){
  const attempts=[];
  const tryStep = async (label, params, manual=false) => {
    try{
      const r = await afetch('fixtures', params);
      let arr = Array.isArray(r?.response)? r.response : [];
      if(manual){
        const keep = new Set(['NS','TBD','PST']);
        arr = arr.filter(fx => keep.has(String(fx?.fixture?.status?.short||'').toUpperCase()));
      }
      attempts.push({step:label,count:arr.length});
      return arr.length? arr : null;
    }catch(e){
      attempts.push({step:label,error:e?.status || 'err'});
      return null;
    }
  };

  const list =
    await tryStep('status=NS',                { date, status:'NS' }) ||
    await tryStep('status=NS&tz=UTC',         { date, status:'NS', timezone:'UTC' }) ||
    await tryStep('status=NS&tz=Belgrade',    { date, status:'NS', timezone:TZ_DISPLAY }) ||
    await tryStep('tz=UTC + manual',          { date, timezone:'UTC' }, true) ||
    await tryStep('tz=Belgrade + manual',     { date, timezone:TZ_DISPLAY }, true) ||
    await tryStep('from/to UTC + manual',     { from:date, to:date, timezone:'UTC' }, true) ||
    await tryStep('from/to Belgrade + manual',{ from:date, to:date, timezone:TZ_DISPLAY }, true);

  return { fixtures: list || [], debug: { attempts } };
}

// ---------- STANDINGS ----------
async function getStandings(leagueId, season){
  const key = `${leagueId}-${season}`;
  const c = standingsCache.get(key);
  if(c && Date.now()-c.fetchedAt < TTL_STANDINGS) return c.table;
  const data = await afetch('standings', { league:leagueId, season });
  const table = Array.isArray(data?.response?.[0]?.league?.standings?.[0]) ? data.response[0].league.standings[0] : [];
  standingsCache.set(key, {fetchedAt: Date.now(), table});
  return table;
}
function positionInfo(table, teamId){
  const row = (table||[]).find(r => r?.team?.id===teamId);
  if(!row) return { pos:null, played:null, points:null };
  return { pos: toNum(row?.rank, null), played: toNum(row?.all?.played, null), points: toNum(row?.points, null) };
}

// ---------- TEAM STATS (λ iz goals averages) ----------
async function getTeamStats(teamId, leagueId, season){
  const key = `${teamId}-${leagueId}-${season}`;
  const c = teamStatsCache.get(key);
  if(c && Date.now()-c.fetchedAt < TTL_STATS) return c.stats;

  const data = await afetch('teams/statistics', { team:teamId, league:leagueId, season });
  const g = data?.response?.goals;

  // API-Football daje stringove npr "1.6" ili "-" — moramo parsirati
  const home_for   = g?.for?.average?.home && g.for.average.home !== '-' ? toNum(g.for.average.home, 1.2) : 1.2;
  const home_again = g?.against?.average?.home && g.against.average.home !== '-' ? toNum(g.against.average.home, 1.0) : 1.0;
  const away_for   = g?.for?.average?.away && g.for.average.away !== '-' ? toNum(g.for.average.away, 1.1) : 1.1;
  const away_again = g?.against?.average?.away && g.against.average.away !== '-' ? toNum(g.against.average.away, 1.2) : 1.2;

  const stats = { home_for, home_again, away_for, away_again };
  teamStatsCache.set(key, {fetchedAt: Date.now(), stats});
  return stats;
}

// ---------- RECENT FORM (last 5) ----------
async function getTeamRecentForm(teamId, season){
  const key = `team-${teamId}-${season}`;
  const c = formCache.get(key);
  if(c && Date.now()-c.fetchedAt < TTL_FORM) return c.form;

  const data = await afetch('fixtures', { team: teamId, season, last: '5' });
  const arr = Array.isArray(data?.response)? data.response : [];
  let pts=0,gf=0,ga=0,played=0,w=0,d=0,l=0, lastDate=null;
  for(const fx of arr){
    const hs = toNum(fx?.goals?.home, 0), as = toNum(fx?.goals?.away, 0);
    const isHome = fx?.teams?.home?.id === teamId;
    const my = isHome? hs : as, opp = isHome? as : hs;
    gf += my; ga += opp; played++;
    const wh = fx?.teams?.home?.winner===true, wa = fx?.teams?.away?.winner===true;
    if(wh && isHome || wa && !isHome) { pts+=3; w++; } else if(!wh && !wa) { pts+=1; d++; } else { l++; }
    lastDate = fx?.fixture?.date || lastDate;
  }
  const ppg = played? pts/played : 0;
  const form = { played, points:pts, ppg, gf, ga, gd: gf-ga, wins:w, draws:d, losses:l, lastDate };
  formCache.set(key, {fetchedAt: Date.now(), form});
  return form;
}

// ---------- H2H (last 5) ----------
async function getH2H(homeId, awayId){
  const key = `h2h-${homeId}-${awayId}`;
  const c = h2hCache.get(key);
  if(c && Date.now()-c.fetchedAt < TTL_H2H) return c.stats;

  const data = await afetch('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: '5' });
  const arr = Array.isArray(data?.response)? data.response : [];
  let h=0,a=0,d=0;
  for(const fx of arr){
    const wh = fx?.teams?.home?.winner===true, wa = fx?.teams?.away?.winner===true;
    if(wh) h++; else if(wa) a++; else d++;
  }
  const stats = { h, a, d, played: arr.length };
  h2hCache.set(key, {fetchedAt: Date.now(), stats});
  return stats;
}

// ---------- ODDS (best match winner) ----------
async function getOddsBestForFixture(fixtureId){
  const key = `fixture-${fixtureId}`;
  const c = oddsCache.get(key);
  if(c && Date.now()-c.fetchedAt < TTL_ODDS) return c;

  // Pokušaj odds po fixture-u (ako plan ima ovaj endpoint)
  try{
    const r = await afetch('odds', { fixture: fixtureId });
    const arr = Array.isArray(r?.response)? r.response : [];
    let best = { home:0, draw:0, away:0 }, bookies=0;

    for(const row of arr){
      const bets = Array.isArray(row?.bookmakers?.[0]?.bets) ? row.bookmakers[0].bets : row?.bookmakers?.flatMap(b=>b.bets)||[];
      if(!bets || !bets.length) continue;
      // tražimo "Match Winner"
      const mw = bets.find(b => (String(b?.name||'').toLowerCase().includes('match winner')) || b?.id===1);
      if(!mw) continue;
      const outs = Array.isArray(mw?.values)? mw.values : [];
      if(!outs.length) continue;

      let h=null,d=null,a=null;
      for(const o of outs){
        const name = (o?.value ?? o?.name ?? '').toString().toLowerCase();
        const price = toNum(o?.odd ?? o?.price ?? o?.decimal, 0);
        if(name.includes('home') || name === '1') h = Math.max(h??0, price);
        else if(name.includes('draw') || name === 'x') d = Math.max(d??0, price);
        else if(name.includes('away') || name === '2') a = Math.max(a??0, price);
      }
      if(h || d || a){
        best.home = Math.max(best.home, h||0);
        best.draw = Math.max(best.draw, d||0);
        best.away = Math.max(best.away, a||0);
        bookies++;
      }
    }
    const out = { fetchedAt: Date.now(), best, bookies };
    oddsCache.set(key, out);
    return out;
  }catch{
    // nema odds plana ili prazan odgovor
    const out = { fetchedAt: Date.now(), best: {home:0,draw:0,away:0}, bookies: 0 };
    oddsCache.set(key, out);
    return out;
  }
}

function impliedFromBest(best){
  const invH = best.home? 1/best.home : 0, invD = best.draw? 1/best.draw : 0, invA = best.away? 1/best.away : 0;
  const s = invH + invD + invA; if(s<=0) return { home:0, draw:0, away:0, overround:0 };
  return { home: invH/s, draw: invD/s, away: invA/s, overround: s };
}

// ---------- Poisson + blagi Dixon–Coles ----------
function poissonPMF(k, lambda){
  // e^{-lambda} * lambda^k / k!
  if(lambda<=0) return (k===0?1:0);
  // stabilna aproksimacija
  let log = -lambda + (k? k*Math.log(lambda) - logFactorial(k) : 0);
  return Math.max(0, Math.exp(log));
}
const factMemo = new Map([[0,0],[1,0]]);
function logFactorial(n){
  if(factMemo.has(n)) return factMemo.get(n);
  let s=0; for(let i=2;i<=n;i++) s += Math.log(i);
  factMemo.set(n, s);
  return s;
}
function dcAdjust(i,j,rho){
  // veoma blaga korekcija za male rezultate
  // tipično pozitivna korelacija za 0-0 i 1-1; negativna za 1-0 / 0-1 (ili obrnuto zavisno od liter.)
  // mi koristimo jednostavan faktor:
  if(i===0 && j===0) return 1 + 0.05*rho;
  if(i===1 && j===0) return 1 - 0.03*rho;
  if(i===0 && j===1) return 1 - 0.03*rho;
  if(i===1 && j===1) return 1 + 0.04*rho;
  return 1;
}
function probs1x2(lambdaH, lambdaA, rho=DC_RHO){
  let pH=0, pD=0, pA=0;
  // ograničimo sumiranje do 8 golova po timu (ostatak zanemarljiv)
  const MAXG=8;
  for(let i=0;i<=MAXG;i++){
    const ph = poissonPMF(i, lambdaH);
    for(let j=0;j<=MAXG;j++){
      const pa = poissonPMF(j, lambdaA);
      let p = ph*pa*dcAdjust(i,j,rho);
      if(i>j) pH += p;
      else if(i===j) pD += p;
      else pA += p;
    }
  }
  // normalizuj ako korekcija promeni sumu
  const s = pH+pD+pA;
  if(s>0){ pH/=s; pD/=s; pA/=s; }
  return { home:pH, draw:pD, away:pA };
}

// λ estimacija iz team stats + standings/form/H2H sitne korekcije
function lambdaPair(statsH, statsA, posH, posA, formH, formA){
  // osnovno: domaćin napad vs gost odbrana; gost napad vs domaćin odbrana
  let lamH = 0.5*(statsH.home_for + statsA.away_again) + PRIOR_HOME; // blagi home edge
  let lamA = 0.5*(statsA.away_for + statsH.home_again);

  // pozicije: ako je domaćin bolji plasiran, blago +; ako lošiji, blago -
  if(posH && posA){
    const diff = clamp((posA - posH)/20, -1, 1); // grubo, jer ne znamo veličinu tabele ovde
    lamH *= (1 + 0.10*diff);
    lamA *= (1 - 0.07*diff);
  }

  // forma (ppg razlika normalizovana na [-1,1])
  const ppgH = formH?.ppg ?? 1.3;
  const ppgA = formA?.ppg ?? 1.3;
  const fDiff = clamp((ppgH - ppgA)/3, -1, 1);
  lamH *= (1 + 0.08*fDiff);
  lamA *= (1 - 0.06*fDiff);

  // granice da ne „pobegnu“
  lamH = clamp(lamH, 0.4, 3.5);
  lamA = clamp(lamA, 0.2, 3.0);
  return { lamH, lamA };
}

function confidenceFromProbs(probs, formH, formA){
  const arr=[probs.home, probs.draw, probs.away].sort((a,b)=>b-a);
  const top=arr[0], second=arr[1];
  const gap=clamp(top-second,0,0.35);
  const formScore = (formH && formA) ? clamp((formH.ppg - formA.ppg + 3)/6, 0, 1) : 0.5;
  // final skala ~50–92
  const c = 0.65*top + 0.20*(gap/0.35) + 0.15*formScore;
  return Math.round(clamp(50 + c*42, 50, 92));
}

function scoreForRanking(p, ev, bookies){
  // prioritet verovatnoći i EV; bookies kao signal likvidnosti
  const bk = clamp((bookies||0)/10, 0, 1);
  const evn = clamp((ev||0)/0.1, 0, 1); // EV 10% saturira
  const pn  = clamp((p||0), 0, 1);
  return Math.round(100*(0.6*pn + 0.3*evn + 0.1*bk));
}

// ---------- MAIN HANDLER ----------
export default async function handler(req,res){
  try{
    if(!APIF_KEY){
      return res.status(200).json({ value_bets: [], note:'Missing API_FOOTBALL_KEY', generated_at:new Date().toISOString() });
    }

    const url = new URL(req.url,'http://localhost');
    const date = url.searchParams.get('date') || todayYMD('UTC');
    const rawMax = url.searchParams.get('max');
    const max = Math.max(1, toNum(rawMax, MAX_FIXTURES));
    const wantDebug = url.searchParams.get('debug') === '1';

    const { fixtures, debug: fxDbg } = await fetchFixturesForDate(date);
    if(!fixtures.length){
      const payload = { value_bets: [], generated_at: new Date().toISOString(), debug: { date, fixtures_debug: fxDbg } };
      res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=300');
      return res.status(200).json(payload);
    }

    // standings cache po ligi
    const standingsByKey = new Map();
    const leagueSeasonPairs = new Map();
    for(const fx of fixtures){
      const lid = fx?.league?.id, season = fx?.league?.season;
      if(lid && season) leagueSeasonPairs.set(`${lid}-${season}`, {leagueId: lid, season});
    }
    for(const {leagueId, season} of leagueSeasonPairs.values()){
      try{
        const table = await getStandings(leagueId, season);
        standingsByKey.set(`${leagueId}-${season}`, table);
      }catch{
        standingsByKey.set(`${leagueId}-${season}`, []);
      }
    }

    const use = fixtures.slice(0, max);
    const picks = [];

    for(const fx of use){
      try{
        const fixture_id = fx?.fixture?.id;
        const leagueId = fx?.league?.id, season = fx?.league?.season, leagueName = fx?.league?.name;
        const homeId = fx?.teams?.home?.id,   awayId = fx?.teams?.away?.id;
        const homeName = fx?.teams?.home?.name, awayName = fx?.teams?.away?.name;
        const startLocal = formatLocal(fx?.fixture?.date);

        const table = standingsByKey.get(`${leagueId}-${season}`) || [];
        const infoH = positionInfo(table, homeId);
        const infoA = positionInfo(table, awayId);

        const statsH = await getTeamStats(homeId, leagueId, season);
        const statsA = await getTeamStats(awayId, leagueId, season);
        const formH  = await getTeamRecentForm(homeId, season);
        const formA  = await getTeamRecentForm(awayId, season);
        const h2h    = await getH2H(homeId, awayId);

        // osnovne λ pa blagi DC
        const { lamH, lamA } = lambdaPair(statsH, statsA, infoH.pos, infoA.pos, formH, formA);
        let model = probs1x2(lamH, lamA, DC_RHO);

        // blend sa liga prior-om: blago „smiri“ nerešeno ka prioru
        const pD = shrink(model.draw * 0.8 + PRIOR_DRAW * 0.2);
        // redistribuiraj višak/manjak proporcionalno na home/away
        const sumHA = model.home + model.away;
        const scale = sumHA>0 ? (1 - pD)/sumHA : 1;
        model = { home: shrink(model.home * scale), draw: pD, away: shrink(model.away * scale) };

        // izaberi selekciju sa najvećom verovatnoćom
        let sel='1', mprob=model.home;
        if(model.draw >= mprob){ sel='X'; mprob=model.draw; }
        if(model.away >= mprob){ sel='2'; mprob=model.away; }

        // pokušaj odds (ako postoji u planu)
        const oddsInfo = await getOddsBestForFixture(fixture_id);
        const implied  = impliedFromBest(oddsInfo.best);
        const selectedOdds = sel==='1' ? oddsInfo.best.home : sel==='X' ? oddsInfo.best.draw : oddsInfo.best.away;

        // EV ako imamo kvote
        let ev = null, type = 'FALLBACK';
        if(selectedOdds && selectedOdds>1.01){
          ev = mprob * selectedOdds - 1;
          type = (oddsInfo.bookies >= BOOKIES_MIN && ev >= MIN_EV) ? 'MODEL+ODDS' : 'FALLBACK';
        }

        const confPct = confidenceFromProbs(model, formH, formA);
        const confBucket = bucketFromPct(confPct);

        const score = scoreForRanking(mprob, ev, oddsInfo.bookies);

        picks.push({
          fixture_id,
          market: "1X2",
          selection: sel,
          type,
          model_prob: mprob,
          market_odds: selectedOdds || null,
          edge: (selectedOdds && selectedOdds>1.01) ? (mprob - (sel==='1'?implied.home:sel==='X'?implied.draw:implied.away)) : null,
          datetime_local: { starting_at: { date_time: startLocal } },
          teams: { home: { id: homeId, name: homeName }, away: { id: awayId, name: awayName } },
          league: { id: leagueId, name: leagueName, season },
          confidence_pct: confPct,
          confidence_bucket: confBucket,
          _score: score,
          _meta: {
            lambda: { home: lamH, away: lamA },
            form: {
              home: { ppg: formH.ppg, gf: formH.gf, ga: formH.ga, wins: formH.wins, draws: formH.draws, losses: formH.losses },
              away: { ppg: formA.ppg, gf: formA.gf, ga: formA.ga, wins: formA.wins, draws: formA.draws, losses: formA.losses },
            },
            h2h: h2h?.played ? { h:h2h.h, d:h2h.d, a:h2h.a, played:h2h.played } : null,
            bookies: oddsInfo.bookies || 0,
            implied: implied,
            ev,
          }
        });
      }catch(e){
        // pojedinačni meč može da padne — nastavi
      }
    }

    // Rangiranje: MODEL+ODDS prioritet, zatim _score
    picks.sort((a,b)=>{
      if(a.type!==b.type){
        if(a.type==='MODEL+ODDS') return -1;
        if(b.type==='MODEL+ODDS') return 1;
      }
      return toNum(b._score,0) - toNum(a._score,0);
    });

    // Top 10 za UI
    const top = picks.slice(0,10);

    const payload = {
      value_bets: top,
      generated_at: new Date().toISOString()
    };
    if(wantDebug) payload.debug = { date, fixtures_debug: fxDbg, picked: top.length, total_considered: use.length };

    res.setHeader('Cache-Control','s-maxage=900, stale-while-revalidate=600');
    return res.status(200).json(payload);
  }catch(e){
    res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=120');
    return res.status(200).json({ value_bets: [], note: e?.message || String(e), generated_at: new Date().toISOString() });
  }
}
