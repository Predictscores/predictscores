// FILE: pages/api/value-bets.js

export const config = { api: { bodyParser: false } };

const AF_BASE = 'https://v3.football.api-sports.io';
const AF_KEY  = process.env.API_FOOTBALL_KEY || '';
const TZ_DISPLAY = process.env.TZ_DISPLAY || 'Europe/Belgrade';

// --- simple in-memory caches (resetuju se na cold start) ---
const fixturesCache = { key: null, at: 0, data: null };        // key = YYYY-MM-DD
const h2hCache = new Map();                                     // key = `${homeId}-${awayId}`, val: {at, data}

function todayYMD(tz = TZ_DISPLAY) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [{ value: y }, , { value: m }, , { value: dd }] = fmt.formatToParts(d);
  return `${y}-${m}-${dd}`;
}

function toBelgrade(dateIso) {
  if (!dateIso) return '';
  const d = new Date(dateIso);
  const fmtDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_DISPLAY, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const fmtTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ_DISPLAY, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const [{ value: y }, , { value: m }, , { value: da }] = fmtDate.formatToParts(d);
  return `${y}-${m}-${da} ${fmtTime.format(d)}`;
}

async function afFetch(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${AF_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': AF_KEY } });
  if (!res.ok) throw new Error(`API-FOOTBALL ${res.status}`);
  const json = await res.json();
  return json;
}

// jednostavan 1X2 model (placeholder): home 45%, draw 25%, away 30%,
// + mala korekcija za "domacinstvo"
function simpleModel() {
  const home = 0.45, draw = 0.25, away = 0.30;
  let selection = 'home', prob = home;
  if (away > home && away > draw) { selection = 'away'; prob = away; }
  else if (draw > home && draw > away) { selection = 'draw'; prob = draw; }
  return { probs: { home, draw, away }, selection, prob };
}

function bucket(p) {
  if (p >= 0.90) return 'TOP';
  if (p >= 0.75) return 'High';
  if (p >= 0.50) return 'Moderate';
  return 'Low';
}

// H2H (poslednjih 5) keširano ~3h
async function getH2H(homeId, awayId) {
  if (!homeId || !awayId) return null;
  const key = `${homeId}-${awayId}`;
  const now = Date.now();
  const cached = h2hCache.get(key);
  if (cached && now - cached.at < 3 * 3600_000) return cached.data;

  try {
    const json = await afFetch('/fixtures/headtohead', { h2h: key, last: 5 });
    const list = Array.isArray(json?.response) ? json.response : [];
    let H = 0, D = 0, A = 0, gH = 0, gA = 0;
    const last5 = list.slice(0, 5).map(r => {
      const hs = r.goals?.home ?? 0;
      const as = r.goals?.away ?? 0;
      gH += hs; gA += as;
      if (hs > as) H++; else if (hs < as) A++; else D++;
      return {
        date: r.fixture?.date || null,
        home: r.teams?.home?.name || 'Home',
        away: r.teams?.away?.name || 'Away',
        hs, as
      };
    });
    const data = { H, D, A, gH, gA, last5 };
    h2hCache.set(key, { at: now, data });
    return data;
  } catch {
    return null;
  }
}

// Dohvati dnevne mečeve (keš ~1h)
async function getFixtures(date) {
  const key = date;
  const now = Date.now();
  if (fixturesCache.key === key && fixturesCache.data && now - fixturesCache.at < 3600_000) {
    return fixturesCache.data;
  }
  const json = await afFetch('/fixtures', { date });
  const list = Array.isArray(json?.response) ? json.response : [];
  fixturesCache.key = key;
  fixturesCache.data = list;
  fixturesCache.at = now;
  return list;
}

function selectTop(list) {
  // sortiramo kroz jednostavan “score” (confidence), pokupimo do 10
  const rows = list.map(f => {
    const m = simpleModel();
    const confPct = Math.round(m.prob * 100);
    // minimalno rangiranje: viša liga prioritet + kasnije filtriranje lako menjaš
    const score = confPct;
    return { f, m, confPct, score };
  }).sort((a, b) => b.score - a.score);
  return rows.slice(0, 10);
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const date = url.searchParams.get('date') || todayYMD();

    const fixtures = await getFixtures(date);
    const top = selectTop(fixtures);

    // paralelno pokupi H2H za top parove
    const enriched = await Promise.all(top.map(async row => {
      const f = row.f;
      const home = f.teams?.home?.name || 'Home';
      const away = f.teams?.away?.name || 'Away';
      const homeId = f.teams?.home?.id;
      const awayId = f.teams?.away?.id;

      const h2h = await getH2H(homeId, awayId); // može biti null

      const sel = row.m.selection === 'home' ? '1' : row.m.selection === 'away' ? '2' : 'X';

      return {
        fixture_id: f.fixture?.id ?? null,
        market: '1X2',
        selection: sel,
        type: 'FALLBACK',            // nemamo “market_odds” u ovoj varijanti
        model_prob: row.m.prob,
        market_odds: null,
        edge: null,
        datetime_local: {
          starting_at: { date_time: toBelgrade(f.fixture?.date) }
        },
        teams: {
          home: { id: homeId ?? null, name: home },
          away: { id: awayId ?? null, name: away }
        },
        league: {
          id: f.league?.id ?? null,
          name: f.league?.name ?? 'League',
          country: f.league?.country ?? null
        },
        confidence_pct: row.confPct,
        confidence_bucket: bucket(row.m.prob),
        _score: row.score,
        // NOVO:
        h2h // {H,D,A,gH,gA,last5:[...]} ili null
      };
    }));

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=1800');
    return res.status(200).json({ value_bets: enriched, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('value-bets error:', e?.message || e);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
    return res.status(200).json({ value_bets: [], note: 'error, returned empty' });
  }
}
