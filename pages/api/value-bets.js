// FILE: pages/api/value-bets.js
//
// Korak A + DIJAGNOSTIKA:
// - Pokuša tri načina da dođe do dnevnih mečeva (status=NS, pa sa timezone=UTC, pa fallback bez filtera)
// - Ako i dalje nema, vraća debug polje da odmah vidimo zašto je prazno
// - Standings + recent form + H2H sa kešom kao ranije
//
// ENV: API_FOOTBALL_KEY (obavezno), TZ_DISPLAY (opciono)

export const config = { api: { bodyParser: false } };

const APIF_KEY = process.env.API_FOOTBALL_KEY || "";
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

const MAX_FIXTURES_DEF = 30;
const RECENT_N = 5;
const DRAW_FLOOR = 0.18, DRAW_CAP = 0.38;

const CACHE_TTL_STANDINGS = 6 * 3600_000;
const CACHE_TTL_FORM = 3 * 3600_000;
const CACHE_TTL_H2H = 6 * 3600_000;

const standingsCache = new Map();
const formCache = new Map();
const h2hCache = new Map();

function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function toNum(x,d=0){const n=Number(x);return Number.isFinite(n)?n:d}

function todayYMD(tz="UTC"){
  const d=new Date();
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
  const [{value:y},, {value:m},, {value:da}] = fmt.formatToParts(d);
  return `${y}-${m}-${da}`;
}
function formatLocal(isoUtcLike){
  try{
    if(!isoUtcLike) return "";
    const utc=isoUtcLike.endsWith('Z')?isoUtcLike:isoUtcLike+'Z';
    const d=new Date(utc);
    const dateFmt=new Intl.DateTimeFormat('en-CA',{timeZone:TZ_DISPLAY,year:'numeric',month:'2-digit',day:'2-digit'});
    const timeFmt=new Intl.DateTimeFormat('en-GB',{timeZone:TZ_DISPLAY,hour:'2-digit',minute:'2-digit',hour12:false});
    const [{value:y},, {value:m},, {value:dd}] = dateFmt.formatToParts(d);
    return `${y}-${m}-${dd} ${timeFmt.format(d)}`;
  }catch{return isoUtcLike}
}
function bucketFromPct(p){ if(p>=90) return "TOP"; if(p>=75) return "High"; if(p>=50) return "Moderate"; return "Low"; }

async function afetch(path, search = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(search).forEach(([k,v])=> url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': APIF_KEY } });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(`API-Football ${path} ${res.status}`);
    err.status = res.status; err.payload = json;
    throw err;
  }
  return json;
}

// --- cache helpers ---
async function getStandings(leagueId, season){
  const key = `${leagueId}-${season}`;
  const c = standingsCache.get(key);
  if (c && Date.now()-c.fetchedAt < CACHE_TTL_STANDINGS) return c.table;
  const data = await afetch('standings', { league: leagueId, season });
  const table = Array.isArray(data?.response?.[0]?.league?.standings?.[0]) ? data.response[0].league.standings[0] : [];
  standingsCache.set(key, { fetchedAt: Date.now(), table });
  return table;
}
async function getTeamRecentForm(teamId, season){
  const key = `team-${teamId}-${season}`;
  const c = formCache.get(key);
  if (c && Date.now()-c.fetchedAt < CACHE_TTL_FORM) return c.form;

  const data = await afetch('fixtures', { team: teamId, season, last: String(RECENT_N) });
  const arr = Array.isArray(data?.response) ? data.response : [];
  let pts=0,gf=0,ga=0,played=0,w=0,d=0,l=0;
  for(const fx of arr){
    const hs=toNum(fx?.goals?.home,0), as=toNum(fx?.goals?.away,0);
    const isHome = fx?.teams?.home?.id === teamId;
    const my = isHome ? hs : as, opp = isHome ? as : hs;
    gf += my; ga += opp; played++;
    const wh = fx?.teams?.home?.winner===true, wa = fx?.teams?.away?.winner===true;
    if (wh && isHome || wa && !isHome) { pts+=3; w++; }
    else if (!wh && !wa) { pts+=1; d++; }
    else { l++; }
  }
  const form = { played, points: pts, ppg: played?pts/played:0, gf, ga, gd: gf-ga, wins:w, draws:d, losses:l };
  formCache.set(key, { fetchedAt: Date.now(), form });
  return form;
}
async function getH2H(homeId, awayId){
  const key = `h2h-${homeId}-${awayId}`;
  const c = h2hCache.get(key);
  if (c && Date.now()-c.fetchedAt < CACHE_TTL_H2H) return c.stats;

  const data = await afetch('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: String(RECENT_N) });
  const arr = Array.isArray(data?.response) ? data.response : [];
  let h=0,a=0,d=0;
  for(const fx of arr){
    const wh = fx?.teams?.home?.winner===true, wa = fx?.teams?.away?.winner===true;
    if(wh) h++; else if(wa) a++; else d++;
  }
  const stats = { h, a, d, played: arr.length };
  h2hCache.set(key, { fetchedAt: Date.now(), stats });
  return stats;
}

function positionInfo(table, teamId){
  const row = (table||[]).find(r => r?.team?.id===teamId);
  if(!row) return { pos:null, played:null, points:null };
  return { pos: toNum(row?.rank,null), played: toNum(row?.all?.played,null), points: toNum(row?.points,null) };
}

function model1x2({ posHome, posAway, tableSize, formH, formA, h2h }){
  let pH=0.40, pD=0.28, pA=0.32;
  if(posHome && posAway && tableSize){
    const diff = clamp((posAway-posHome)/tableSize, -1, 1);
    const adj = 0.15*diff;
    pH += adj; pA -= adj;
  }
  if(formH && formA){
    const diffPPG = clamp((formH.ppg-formA.ppg)/3, -1, 1);
    const adj = 0.12*diffPPG;
    pH += adj; pA -= adj;
  }
  if(h2h && h2h.played>0){
    const diffH2H = clamp((h2h.h - h2h.a)/Math.max(1,h2h.played), -1, 1);
    const adj = 0.05*diffH2H;
    pH += adj; pA -= adj;
  }
  pD = clamp(pD, DRAW_FLOOR, DRAW_CAP);
  const sum = pH+pD+pA;
  pH/=sum; pD/=sum; pA/=sum;
  pH = clamp(pH,0.05,0.85);
  pA = clamp(pA,0.05,0.85);
  const rest = clamp(1-(pH+pA), DRAW_FLOOR, DRAW_CAP);
  const s2 = pH+pA+rest;
  pH/=s2; pA/=s2; pD=rest/s2;
  return { home:pH, draw:pD, away:pA };
}

function confidenceFromProbs(probs, formH, formA){
  const arr=[probs.home, probs.draw, probs.away].sort((a,b)=>b-a);
  const top=arr[0], second=arr[1];
  const gap=clamp(top-second,0,0.35);
  const formScore=formH&&formA? clamp((formH.ppg-formA.ppg+3)/6,0,1):0.5;
  const c = 0.65*top + 0.20*(gap/0.35) + 0.15*formScore;
  return Math.round(clamp(50 + c*42, 50, 92));
}
function scoreForRanking(model, formH, formA){
  const probTop=Math.max(model.home, model.draw, model.away);
  const formDiff=(formH?.ppg||0)-(formA?.ppg||0);
  return Math.round((0.7*probTop + 0.3*((formDiff+3)/6))*100);
}

// --- fixtures fetch sa fallback-ovima + debug ---
async function fetchDayFixturesRobust(date){
  const debug = { attempts: [] };

  // 1) status=NS
  try{
    const d1 = await afetch('fixtures', { date, status:'NS' });
    const list1 = Array.isArray(d1?.response) ? d1.response : [];
    debug.attempts.push({ step:'status=NS', count:list1.length });
    if(list1.length) return { fixtures:list1, debug };
  }catch(e){
    debug.attempts.push({ step:'status=NS', error: e?.status || 'err' });
  }

  // 2) status=NS + timezone=UTC (za svaki slučaj)
  try{
    const d2 = await afetch('fixtures', { date, status:'NS', timezone:'UTC' });
    const list2 = Array.isArray(d2?.response) ? d2.response : [];
    debug.attempts.push({ step:'status=NS&tz=UTC', count:list2.length });
    if(list2.length) return { fixtures:list2, debug };
  }catch(e){
    debug.attempts.push({ step:'status=NS&tz=UTC', error: e?.status || 'err' });
  }

  // 3) Bez status filtera, pa ručno filtriranje po status.short
  try{
    const d3 = await afetch('fixtures', { date, timezone:'UTC' });
    let list3 = Array.isArray(d3?.response) ? d3.response : [];
    const keep = new Set(['NS','TBD','PST']); // not started / postponed / to be defined
    list3 = list3.filter(fx => keep.has(String(fx?.fixture?.status?.short || '').toUpperCase()));
    debug.attempts.push({ step:'tz=UTC + manual filter', count:list3.length });
    if(list3.length) return { fixtures:list3, debug };
  }catch(e){
    debug.attempts.push({ step:'tz=UTC + manual filter', error: e?.status || 'err' });
  }

  return { fixtures: [], debug };
}

export default async function handler(req,res){
  try{
    if(!APIF_KEY){
      return res.status(200).json({ value_bets: [], note:'Missing API_FOOTBALL_KEY', generated_at:new Date().toISOString() });
    }
    const url = new URL(req.url,'http://localhost');
    const date = url.searchParams.get('date') || todayYMD('UTC');
    const max = toNum(url.searchParams.get('max'), MAX_FIXTURES_DEF);
    const wantDebug = url.searchParams.get('debug') === '1';

    const { fixtures, debug: fxDbg } = await fetchDayFixturesRobust(date);

    if(!fixtures.length){
      return res.status(200).json({
        value_bets: [],
        generated_at: new Date().toISOString(),
        debug: { date, fixtures_debug: fxDbg }
      });
    }

    // grupiši lige radi standings-a
    const leagueSeasonPairs = new Map();
    for(const fx of fixtures){
      const lid = fx?.league?.id, season = fx?.league?.season;
      if(lid && season) leagueSeasonPairs.set(`${lid}-${season}`, {leagueId: lid, season});
    }

    const standingsByKey = new Map();
    for(const {leagueId,season} of leagueSeasonPairs.values()){
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
        const homeId = fx?.teams?.home?.id, awayId = fx?.teams?.away?.id;
        const homeName = fx?.teams?.home?.name, awayName = fx?.teams?.away?.name;
        const belgrade = formatLocal(fx?.fixture?.date);

        const table = standingsByKey.get(`${leagueId}-${season}`) || [];
        const infoH = positionInfo(table, homeId);
        const infoA = positionInfo(table, awayId);
        const tableSize = table?.length || 0;

        const formH = await getTeamRecentForm(homeId, season);
        const formA = await getTeamRecentForm(awayId, season);
        const h2h = await getH2H(homeId, awayId);

        const model = model1x2({ posHome:infoH.pos, posAway:infoA.pos, tableSize, formH, formA, h2h });

        let sel='1', mprob=model.home;
        if(model.draw >= mprob){ sel='X'; mprob=model.draw; }
        if(model.away >= mprob){ sel='2'; mprob=model.away; }

        const confPct = confidenceFromProbs(model, formH, formA);
        const confBucket = bucketFromPct(confPct);

        const h2hText = h2h?.played ? `H2H (5): H ${h2h.h} D ${h2h.d} A ${h2h.a}` : null;
        const _score = scoreForRanking(model, formH, formA);

        picks.push({
          fixture_id,
          market: "1X2",
          selection: sel,
          type: "FALLBACK",
          model_prob: mprob,
          market_odds: null,
          edge: null,
          datetime_local: { starting_at: { date_time: belgrade } },
          teams: { home: { id: homeId, name: homeName }, away: { id: awayId, name: awayName } },
          league: { id: leagueId, name: leagueName, season },
          confidence_pct: confPct,
          confidence_bucket: confBucket,
          _score,
          _meta: {
            standings: { home: infoH, away: infoA, size: tableSize },
            form: {
              home: { ppg: formH.ppg, gf: formH.gf, ga: formH.ga, wins: formH.wins, draws: formH.draws, losses: formH.losses },
              away: { ppg: formA.ppg, gf: formA.gf, ga: formA.ga, wins: formA.wins, draws: formA.draws, losses: formA.losses },
            },
            h2h: h2hText,
          }
        });
      }catch{}
    }

    picks.sort((a,b)=> toNum(b._score,0) - toNum(a._score,0));
    const top = picks.slice(0,10);

    const payload = { value_bets: top, generated_at: new Date().toISOString() };
    if (wantDebug) payload.debug = { date, fixtures_debug: fxDbg, picked: top.length, total_considered: use.length };
    res.setHeader('Cache-Control','s-maxage=900, stale-while-revalidate=600');
    return res.status(200).json(payload);
  }catch(e){
    res.setHeader('Cache-Control','s-maxage=120, stale-while-revalidate=120');
    return res.status(200).json({ value_bets: [], note: e?.message || String(e), generated_at: new Date().toISOString() });
  }
}
