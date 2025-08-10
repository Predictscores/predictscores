// FILE: pages/api/value-bets.js
//
// Korak A: API-Football -> fixtures za dan, standings, recent form (last 5), H2H (last 5)
// Keširanje po ligi/timu/parovima, štedljiv broj poziva.
// UI-kompatibilan izlaz (type: "FALLBACK"), plus confidence i bucket.
//
// Env:
//  - API_FOOTBALL_KEY   (obavezno, PRO ključ aktivan)
//  - TZ_DISPLAY         (opciono, default "Europe/Belgrade")
//
// Query (opciono):
//  - date=YYYY-MM-DD
//  - max=30            (max broj mečeva koje obrađujemo; default 30)

export const config = { api: { bodyParser: false } };

const APIF_KEY = process.env.API_FOOTBALL_KEY || "";
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Tuning
const MAX_FIXTURES = 30;              // default koliko mečeva obrađujemo
const RECENT_N = 5;                   // poslednjih N mečeva za formu i H2H
const DRAW_FLOOR = 0.18, DRAW_CAP = 0.38;
const CACHE_TTL_STANDINGS = 6 * 3600_000; // 6h
const CACHE_TTL_FORM = 3 * 3600_000;       // 3h
const CACHE_TTL_H2H = 6 * 3600_000;        // 6h

// In-memory cache
const standingsCache = new Map(); // key: `${leagueId}-${season}` -> {fetchedAt, table}
const formCache = new Map();      // key: `team-${teamId}-${season}` -> {fetchedAt, form}
const h2hCache = new Map();       // key: `h2h-${homeId}-${awayId}` -> {fetchedAt, stats}

// --- helpers ---
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function toNum(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

function todayYMD(tz = "UTC") {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [{ value: y }, , { value: m }, , { value: da }] = fmt.formatToParts(d);
  return `${y}-${m}-${da}`;
}
function formatLocal(isoUtcLike) {
  try {
    if (!isoUtcLike) return "";
    const utc = isoUtcLike.endsWith('Z') ? isoUtcLike : isoUtcLike + 'Z';
    const d = new Date(utc);
    const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_DISPLAY, year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_DISPLAY, hour: '2-digit', minute: '2-digit', hour12: false });
    const [{ value: y }, , { value: m }, , { value: dd }] = dateFmt.formatToParts(d);
    return `${y}-${m}-${dd} ${timeFmt.format(d)}`;
  } catch {
    return isoUtcLike;
  }
}
function bucketFromPct(pct) {
  if (pct >= 90) return "TOP";
  if (pct >= 75) return "High";
  if (pct >= 50) return "Moderate";
  return "Low";
}

// API-Football fetch wrapper
async function afetch(path, search = {}) {
  const url = new URL(`https://v3.football.api-sports.io/${path}`);
  Object.entries(search).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'x-apisports-key': APIF_KEY } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`API-Football ${path} ${res.status} ${json?.errors ? JSON.stringify(json.errors) : ''}`);
  }
  return json;
}

// Standings (keš po ligi/sezoni)
async function getStandings(leagueId, season) {
  const key = `${leagueId}-${season}`;
  const cached = standingsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_STANDINGS) return cached.table;

  const data = await afetch('standings', { league: leagueId, season });
  const table = Array.isArray(data?.response?.[0]?.league?.standings?.[0])
    ? data.response[0].league.standings[0] : [];

  standingsCache.set(key, { fetchedAt: Date.now(), table });
  return table;
}

// Recent form (poslednjih N mečeva po timu)
async function getTeamRecentForm(teamId, season) {
  const key = `team-${teamId}-${season}`;
  const cached = formCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_FORM) return cached.form;

  const data = await afetch('fixtures', { team: teamId, season, last: String(RECENT_N) });
  const arr = Array.isArray(data?.response) ? data.response : [];
  let pts = 0, gf = 0, ga = 0, played = 0, wins = 0, draws = 0, losses = 0;

  for (const fx of arr) {
    const hs = toNum(fx?.goals?.home, 0), as = toNum(fx?.goals?.away, 0);
    const homeId = fx?.teams?.home?.id, awayId = fx?.teams?.away?.id;
    const isHome = homeId === teamId;
    const my = isHome ? hs : as;
    const opp = isHome ? as : hs;
    gf += my; ga += opp; played++;

    const winner = fx?.teams?.home?.winner === true ? 'home' :
                   fx?.teams?.away?.winner === true ? 'away' : 'draw';
    let outcome;
    if (winner === 'draw') outcome = 'D';
    else if ((winner === 'home' && isHome) || (winner === 'away' && !isHome)) outcome = 'W';
    else outcome = 'L';

    if (outcome === 'W') { pts += 3; wins++; }
    if (outcome === 'D') { pts += 1; draws++; }
    if (outcome === 'L') { losses++; }
  }

  const form = {
    played,
    points: pts,
    ppg: played ? pts / played : 0,
    gf, ga, gd: gf - ga,
    wins, draws, losses,
  };
  formCache.set(key, { fetchedAt: Date.now(), form });
  return form;
}

// H2H (last N)
async function getH2H(homeId, awayId) {
  const key = `h2h-${homeId}-${awayId}`;
  const cached = h2hCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_H2H) return cached.stats;

  const data = await afetch('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: String(RECENT_N) });
  const arr = Array.isArray(data?.response) ? data.response : [];
  let wH = 0, d = 0, wA = 0;
  for (const fx of arr) {
    const winH = fx?.teams?.home?.winner === true;
    const winA = fx?.teams?.away?.winner === true;
    if (winH) wH++; else if (winA) wA++; else d++;
  }
  const stats = { h: wH, d, a: wA, played: arr.length };
  h2hCache.set(key, { fetchedAt: Date.now(), stats });
  return stats;
}

// Rang (pozicija) helper
function positionInfo(standTable, teamId) {
  const row = (standTable || []).find(r => r?.team?.id === teamId);
  if (!row) return { pos: null, played: null, points: null };
  return {
    pos: toNum(row?.rank, null),
    played: toNum(row?.all?.played, null),
    points: toNum(row?.points, null),
  };
}

// Model 1X2 (rank + forma + h2h, sa normalizacijom)
function model1x2({ posHome, posAway, tableSize, formH, formA, h2h }) {
  // bazne verovatnoće (malo naklonjene domaćinu)
  let pH = 0.40, pD = 0.28, pA = 0.32;

  // rang efekat: što veća razlika (awayPos - homePos), to više ka home
  if (posHome && posAway && tableSize) {
    const diff = clamp((posAway - posHome) / tableSize, -1, 1); // + poz. znamenka leži ka home
    const adj = 0.15 * diff; // težina ranga
    pH += adj;
    pA -= adj;
  }

  // forma: ppg razlika [0..3] -> [-1..1], težina 0.12
  if (formH && formA) {
    const diffPPG = clamp((formH.ppg - formA.ppg) / 3, -1, 1);
    const adj = 0.12 * diffPPG;
    pH += adj;
    pA -= adj;
  }

  // h2h: (h - a)/N, težina 0.05
  if (h2h && h2h.played > 0) {
    const diffH2H = clamp((h2h.h - h2h.a) / Math.max(1, h2h.played), -1, 1);
    const adj = 0.05 * diffH2H;
    pH += adj;
    pA -= adj;
  }

  // granice i normalizacija
  pD = clamp(pD, DRAW_FLOOR, DRAW_CAP);
  // Rebalance da suma bude 1 (pH+pA može izaći iz okvira)
  const sum = pH + pD + pA;
  pH /= sum; pD /= sum; pA /= sum;

  // clamp finalno da sve bude u (0,1)
  pH = clamp(pH, 0.05, 0.85);
  pA = clamp(pA, 0.05, 0.85);
  const rest = clamp(1 - (pH + pA), DRAW_FLOOR, DRAW_CAP);
  const s2 = pH + pA + rest;
  pH /= s2; pA /= s2; pD = rest / s2;

  return { home: pH, draw: pD, away: pA };
}

// Confidence (kalibrisan da bude “iskren”)
function confidenceFromProbs({ home, draw, away }, formH, formA) {
  const arr = [home, draw, away].sort((a, b) => b - a);
  const top = arr[0], second = arr[1];
  const gap = clamp(top - second, 0, 0.35); // veći razmak → više poverenje
  const formScore = formH && formA ? clamp((formH.ppg - formA.ppg + 3) / 6, 0, 1) : 0.5;

  // 65% težina top, 20% gap, 15% forma → skala 0..1
  let c = 0.65 * top + 0.20 * (gap / 0.35) + 0.15 * formScore;

  // “iskrena” skala 50–92%
  const pct = Math.round(clamp(50 + c * 42, 50, 92));
  return pct;
}

// Score za rangiranje (unutar dana)
function scoreForRanking(model, formH, formA) {
  const probTop = Math.max(model.home, model.draw, model.away);
  const formDiff = (formH?.ppg || 0) - (formA?.ppg || 0); // [-3..3]
  const s = 0.7 * probTop + 0.3 * ((formDiff + 3) / 6);
  return Math.round(s * 100);
}

export default async function handler(req, res) {
  try {
    if (!APIF_KEY) {
      return res.status(200).json({ value_bets: [], note: 'Missing API_FOOTBALL_KEY', generated_at: new Date().toISOString() });
    }

    const url = new URL(req.url, 'http://localhost');
    const date = url.searchParams.get('date') || todayYMD('UTC');
    const max = toNum(url.searchParams.get('max'), MAX_FIXTURES);

    // 1) Fixtures za dan (UTC)
    const fixturesJson = await afetch('fixtures', { date, timezone: 'UTC' });
    let fixtures = Array.isArray(fixturesJson?.response) ? fixturesJson.response : [];
    // filtriraj samo “not started / scheduled”
    fixtures = fixtures.filter(fx => (fx?.fixture?.status?.short || '').match(/NS|TBD|PST/i)).slice(0, max);

    // 2) Grupisanje po ligi radi standings keša
    const leagueSeasonPairs = new Map();
    for (const fx of fixtures) {
      const lid = fx?.league?.id, season = fx?.league?.season;
      if (lid && season) leagueSeasonPairs.set(`${lid}-${season}`, { leagueId: lid, season });
    }

    // 3) Preuzmi standings za sve lige (sa kešom)
    const standingsByKey = new Map();
    for (const { leagueId, season } of leagueSeasonPairs.values()) {
      try {
        const table = await getStandings(leagueId, season);
        standingsByKey.set(`${leagueId}-${season}`, table);
      } catch (e) {
        // ako padne standings, samo nastavljamo
        standingsByKey.set(`${leagueId}-${season}`, []);
      }
    }

    // 4) Za svaki meč: recent form za timove + h2h (sa kešom)
    const picks = [];
    for (const fx of fixtures) {
      try {
        const fixture_id = fx?.fixture?.id;
        const leagueId = fx?.league?.id;
        const season = fx?.league?.season;
        const leagueName = fx?.league?.name;
        const homeId = fx?.teams?.home?.id, awayId = fx?.teams?.away?.id;
        const homeName = fx?.teams?.home?.name, awayName = fx?.teams?.away?.name;
        const utcDate = fx?.fixture?.date; // ISO UTC
        const belgrade = formatLocal(utcDate);

        const table = standingsByKey.get(`${leagueId}-${season}`) || [];
        const infoH = positionInfo(table, homeId);
        const infoA = positionInfo(table, awayId);
        const tableSize = table?.length || 0;

        const formH = await getTeamRecentForm(homeId, season);
        const formA = await getTeamRecentForm(awayId, season);
        const h2h = await getH2H(homeId, awayId);

        // model 1X2
        const model = model1x2({
          posHome: infoH.pos, posAway: infoA.pos, tableSize,
          formH, formA, h2h
        });

        // izbor selekcije
        let sel = '1', mprob = model.home;
        if (model.draw >= mprob) { sel = 'X'; mprob = model.draw; }
        if (model.away >= mprob) { sel = '2'; mprob = model.away; }

        // confidence
        const confPct = confidenceFromProbs(model, formH, formA);
        const confBucket = bucketFromPct(confPct);

        // h2h kratak tekst
        const h2hText = h2h?.played
          ? `H2H (5): H ${h2h.h} D ${h2h.d} A ${h2h.a}`
          : null;

        // rang za sortiranje
        const _score = scoreForRanking(model, formH, formA);

        picks.push({
          fixture_id,
          market: "1X2",
          selection: sel,
          type: "FALLBACK", // UI-friendly: “model bez kvota”
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
      } catch {
        // pojedinačan meč može da padne – ignoriši
      }
    }

    // 5) sortiraj i vrati do 10 top (UI ionako traži 3 za Combined)
    picks.sort((a, b) => toNum(b._score, 0) - toNum(a._score, 0));
    const top = picks.slice(0, 10);

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=600'); // 15min / 10min
    return res.status(200).json({
      value_bets: top,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("value-bets KorakA error:", e?.message || e);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=120');
    return res.status(200).json({ value_bets: [], generated_at: new Date().toISOString(), note: 'error, empty' });
  }
}
