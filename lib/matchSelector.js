// FILE: lib/matchSelector.js

const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const LAST_GOOD_TTL_MS = 10 * 60 * 1000; // 10 minuta

const { afxTeamStats } = require('./sources/apiFootball');

const FALLBACK_BASE_PROBS = { home: 0.45, draw: 0.25, away: 0.3 };
const FALLBACK_BTTS_PROBABILITY = 0.4;
const FALLBACK_OVER25_PROBABILITY = 0.32;
const GLOBAL_GOAL_AVG = 1.35;
const MAX_EXPECTED_GOALS = 4.5;
const POISSON_MAX_GOALS = 10;
const DEFAULT_HOME_WIN_RATE = 0.45;
const DEFAULT_AWAY_WIN_RATE = 0.3;
const DEFAULT_DRAW_RATE = 0.25;
const DEFAULT_POINTS_PER_MATCH = 1.35;

// In-memory last good cache (any source)
let lastGood = {
  timestamp: 0,
  picks: null,
  debug: null,
};

// Normalize date to YYYY-MM-DD
function normalizeDateInput(input) {
  let d = null;
  if (input) {
    d = new Date(input);
    if (isNaN(d)) {
      d = new Date(input.replace(/-/g, '/'));
    }
  }
  if (!d || isNaN(d)) {
    d = new Date();
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    used: `${yyyy}-${mm}-${dd}`,
    asDate: d,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function computeFallbackModel() {
  const probs = { ...FALLBACK_BASE_PROBS };
  let predicted = 'home';
  if (probs.away > probs.home && probs.away > probs.draw) predicted = 'away';
  else if (probs.draw > probs.home && probs.draw > probs.away) predicted = 'draw';
  const sorted = Object.entries(probs)
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v);
  const gap = sorted[0].v - sorted[1].v;
  const confidence = Math.min(100, Math.round((gap / 0.5) * 100));
  return {
    model_probs: probs,
    predicted,
    confidence,
    btts_probability: FALLBACK_BTTS_PROBABILITY,
    over25_probability: FALLBACK_OVER25_PROBABILITY,
  };
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.replace(',', '.').trim();
    if (!normalized) return null;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function ratio(part, total) {
  const n = toNumber(part);
  const d = toNumber(total);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

function safeMean(values = []) {
  const arr = values.filter((v) => Number.isFinite(v));
  if (!arr.length) return null;
  const sum = arr.reduce((acc, v) => acc + v, 0);
  return sum / arr.length;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return Number.isFinite(min) ? min : value;
  if (Number.isFinite(max) && value > max) return max;
  if (Number.isFinite(min) && value < min) return min;
  return value;
}

function clampProbability(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function computeFormScore(formStr) {
  if (!formStr) return null;
  const cleaned = String(formStr).toUpperCase().replace(/[^WDL]/g, '');
  if (!cleaned) return null;
  const weights = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < cleaned.length && i < weights.length; i += 1) {
    const ch = cleaned[i];
    const weight = weights[i];
    let value = 0;
    if (ch === 'W') value = 1;
    else if (ch === 'L') value = -1;
    sum += value * weight;
    weightSum += weight;
  }
  return weightSum ? sum / weightSum : null;
}

function parseSeason(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1900 && value <= 2100) return value;
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber >= 1900 && asNumber <= 2100) return asNumber;
    const match = trimmed.match(/(19|20)\d{2}/);
    if (match) {
      const candidate = Number(match[0]);
      if (candidate >= 1900 && candidate <= 2100) return candidate;
    }
    return null;
  }
  if (typeof value === 'object') {
    return (
      parseSeason(value.year) ??
      parseSeason(value.id) ??
      parseSeason(value.season) ??
      (typeof value.name === 'string' ? parseSeason(value.name) : null)
    );
  }
  return null;
}

function parseId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function pickTeamId(team, fallback) {
  if (!team || typeof team !== 'object') {
    return parseId(fallback);
  }
  return (
    parseId(team.id) ??
    parseId(team.team_id) ??
    parseId(team.teamId) ??
    parseId(team?.team?.id) ??
    parseId(team?.data?.id) ??
    parseId(fallback)
  );
}

function extractFixtureMeta(fixture = {}) {
  const leagueData =
    fixture.league?.data ||
    fixture.league ||
    fixture.competition ||
    fixture.tournament ||
    {};
  const homeData =
    fixture.localTeam?.data ||
    fixture.teams?.home ||
    fixture.homeTeam ||
    fixture.team_home ||
    fixture.home ||
    {};
  const awayData =
    fixture.visitorTeam?.data ||
    fixture.teams?.away ||
    fixture.awayTeam ||
    fixture.team_away ||
    fixture.away ||
    {};
  const seasonData = fixture.season?.data || fixture.season || leagueData?.season || {};

  return {
    fixtureId:
      parseId(fixture.id) ??
      parseId(fixture.fixture_id) ??
      parseId(fixture?.fixture?.id) ??
      null,
    leagueId:
      parseId(leagueData.id) ??
      parseId(fixture.league_id) ??
      parseId(fixture.leagueId) ??
      parseId(fixture.competition_id) ??
      null,
    leagueName:
      leagueData.name ??
      fixture.league_name ??
      (fixture.league && fixture.league.name) ??
      (fixture.competition && fixture.competition.name) ??
      null,
    season:
      parseSeason(seasonData) ??
      parseSeason(leagueData.season_id) ??
      parseSeason(fixture.season_id) ??
      parseSeason(fixture.seasonId) ??
      parseSeason(fixture.season) ??
      null,
    homeId: pickTeamId(homeData, fixture.home_id || fixture.homeId),
    awayId: pickTeamId(awayData, fixture.away_id || fixture.awayId),
    homeName:
      homeData.name ||
      fixture.home_name ||
      fixture.homeTeamName ||
      (fixture.home && fixture.home.name) ||
      null,
    awayName:
      awayData.name ||
      fixture.away_name ||
      fixture.awayTeamName ||
      (fixture.away && fixture.away.name) ||
      null,
  };
}

function unwrapTeamStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.response && typeof raw.response === 'object') {
    if (Array.isArray(raw.response)) {
      return raw.response[0] || null;
    }
    return raw.response;
  }
  if (Array.isArray(raw)) return raw[0] || null;
  return raw;
}

function deriveTeamFeatures(stats, sideKey) {
  const side = sideKey === 'home' ? 'home' : 'away';
  const wins = stats?.fixtures?.wins || {};
  const draws = stats?.fixtures?.draws || {};
  const loses = stats?.fixtures?.loses || {};
  const played = stats?.fixtures?.played || {};

  const attackAvg =
    toNumber(stats?.goals?.for?.average?.[side]) ??
    toNumber(stats?.goals?.for?.average?.total);
  const defenseAvg =
    toNumber(stats?.goals?.against?.average?.[side]) ??
    toNumber(stats?.goals?.against?.average?.total);

  const goalsForTotal =
    toNumber(stats?.goals?.for?.total?.[side]) ??
    toNumber(stats?.goals?.for?.total?.total);
  const goalsAgainstTotal =
    toNumber(stats?.goals?.against?.total?.[side]) ??
    toNumber(stats?.goals?.against?.total?.total);

  const points =
    (toNumber(wins?.total) ?? 0) * 3 +
    (toNumber(draws?.total) ?? 0);
  const playedTotal = toNumber(played?.total);
  const pointsPerMatch =
    playedTotal && Number.isFinite(points) ? points / playedTotal : null;

  return {
    attackAvg,
    defenseAvg,
    winRate: ratio(wins?.[side], played?.[side]) ?? ratio(wins?.total, played?.total),
    drawRate: ratio(draws?.[side], played?.[side]) ?? ratio(draws?.total, played?.total),
    loseRate: ratio(loses?.[side], played?.[side]) ?? ratio(loses?.total, played?.total),
    formScore: computeFormScore(stats?.form),
    goalsForTotal,
    goalsAgainstTotal,
    pointsPerMatch,
    leagueAvgFor: toNumber(stats?.goals?.for?.average?.total),
    leagueAvgAgainst: toNumber(stats?.goals?.against?.average?.total),
  };
}

function poissonDistribution(lambda, maxGoals) {
  const arr = new Array(maxGoals + 1).fill(0);
  arr[0] = Math.exp(-lambda);
  let sum = arr[0];
  for (let k = 1; k <= maxGoals; k += 1) {
    arr[k] = (arr[k - 1] * lambda) / k;
    sum += arr[k];
  }
  const remainder = 1 - sum;
  if (remainder > 0) {
    arr[maxGoals] += remainder;
  } else if (remainder < 0 && sum > 0) {
    const scale = 1 / sum;
    for (let k = 0; k <= maxGoals; k += 1) arr[k] *= scale;
  }
  return arr;
}

function computeOutcomeFromExpectedGoals(lambdaHome, lambdaAway) {
  if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) return null;
  const homeDist = poissonDistribution(lambdaHome, POISSON_MAX_GOALS);
  const awayDist = poissonDistribution(lambdaAway, POISSON_MAX_GOALS);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let btts = 0;

  for (let i = 0; i <= POISSON_MAX_GOALS; i += 1) {
    for (let j = 0; j <= POISSON_MAX_GOALS; j += 1) {
      const p = homeDist[i] * awayDist[j];
      if (!Number.isFinite(p) || p <= 0) continue;
      if (i > j) homeWin += p;
      else if (i < j) awayWin += p;
      else draw += p;
      if (i > 0 && j > 0) btts += p;
      if (i + j >= 3) over25 += p;
    }
  }

  const total = homeWin + draw + awayWin;
  if (!(total > 0)) return null;
  const scale = 1 / total;
  return {
    home: homeWin * scale,
    draw: draw * scale,
    away: awayWin * scale,
    over25: clampProbability(over25 * scale),
    btts: clampProbability(btts * scale),
  };
}

function computeProbabilitiesFromFeatures(home, away) {
  const baseAttack =
    safeMean([
      home.leagueAvgFor,
      away.leagueAvgFor,
      home.attackAvg,
      away.attackAvg,
    ]) ?? GLOBAL_GOAL_AVG;
  const baseDefense =
    safeMean([
      home.leagueAvgAgainst,
      away.leagueAvgAgainst,
      home.defenseAvg,
      away.defenseAvg,
    ]) ?? baseAttack ?? GLOBAL_GOAL_AVG;
  const baseline = safeMean([baseAttack, baseDefense]) ?? GLOBAL_GOAL_AVG;

  const homeAttack = Number.isFinite(home.attackAvg) ? home.attackAvg : baseline;
  const awayAttack = Number.isFinite(away.attackAvg) ? away.attackAvg : baseline;
  const homeDefense = Number.isFinite(home.defenseAvg) ? home.defenseAvg : baseDefense;
  const awayDefense = Number.isFinite(away.defenseAvg) ? away.defenseAvg : baseDefense;

  const homeWinRate = Number.isFinite(home.winRate)
    ? home.winRate
    : DEFAULT_HOME_WIN_RATE;
  const awayWinRate = Number.isFinite(away.winRate)
    ? away.winRate
    : DEFAULT_AWAY_WIN_RATE;
  const drawBias = safeMean([home.drawRate, away.drawRate]) ?? DEFAULT_DRAW_RATE;
  const homeForm = Number.isFinite(home.formScore) ? home.formScore : 0;
  const awayForm = Number.isFinite(away.formScore) ? away.formScore : 0;
  const pointsDiff =
    (Number.isFinite(home.pointsPerMatch) ? home.pointsPerMatch : DEFAULT_POINTS_PER_MATCH) -
    (Number.isFinite(away.pointsPerMatch) ? away.pointsPerMatch : DEFAULT_POINTS_PER_MATCH);

  let lambdaHome =
    baseline +
    0.65 * (homeAttack - baseline) +
    0.35 * (awayDefense - baseDefense) +
    0.15 * (homeForm - awayForm) +
    0.1 * (homeWinRate - awayWinRate) +
    0.05 * pointsDiff;

  let lambdaAway =
    baseline +
    0.65 * (awayAttack - baseline) +
    0.35 * (homeDefense - baseDefense) +
    0.15 * (awayForm - homeForm) +
    0.1 * (awayWinRate - homeWinRate) -
    0.05 * pointsDiff;

  lambdaHome = clamp(lambdaHome, 0.15, MAX_EXPECTED_GOALS);
  lambdaAway = clamp(lambdaAway, 0.15, MAX_EXPECTED_GOALS);

  const outcome = computeOutcomeFromExpectedGoals(lambdaHome, lambdaAway);
  if (!outcome) return null;

  let homeProb = outcome.home;
  let drawProb = outcome.draw;
  let awayProb = outcome.away;

  const targetHome = clampProbability(homeWinRate);
  const targetAway = clampProbability(awayWinRate);
  const targetDraw = clampProbability(drawBias, 0, 0.6);
  const targetSum = targetHome + targetDraw + targetAway;
  if (targetSum > 0) {
    const blend = 0.2;
    const normHome = targetHome / targetSum;
    const normDraw = targetDraw / targetSum;
    const normAway = targetAway / targetSum;
    homeProb = blend * normHome + (1 - blend) * homeProb;
    drawProb = blend * normDraw + (1 - blend) * drawProb;
    awayProb = blend * normAway + (1 - blend) * awayProb;
  }

  const total = homeProb + drawProb + awayProb;
  if (!(total > 0)) return null;
  homeProb /= total;
  drawProb /= total;
  awayProb /= total;

  const sorted = [
    { k: 'home', v: homeProb },
    { k: 'draw', v: drawProb },
    { k: 'away', v: awayProb },
  ].sort((a, b) => b.v - a.v);
  const predicted = sorted[0].k;
  const gap = sorted[0].v - sorted[1].v;
  const confidence = Math.min(100, Math.round((gap / 0.5) * 100));

  return {
    model_probs: { home: homeProb, draw: drawProb, away: awayProb },
    predicted,
    confidence,
    btts_probability: clampProbability(outcome.btts),
    over25_probability: clampProbability(outcome.over25),
  };
}

function compactObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

async function computeModelProbs(fixture, metaOverride) {
  const meta = metaOverride || extractFixtureMeta(fixture);
  const missing = [];
  if (!meta.homeId) missing.push('homeId');
  if (!meta.awayId) missing.push('awayId');
  if (!meta.leagueId) missing.push('leagueId');
  if (!meta.season) missing.push('season');
  if (missing.length) {
    return { result: null, reason: 'missing-identifiers', meta, detail: { missing } };
  }

  const [homeRes, awayRes] = await Promise.all([
    afxTeamStats(meta.leagueId, meta.homeId, meta.season)
      .then((res) => ({ res }))
      .catch((error) => ({ error })),
    afxTeamStats(meta.leagueId, meta.awayId, meta.season)
      .then((res) => ({ res }))
      .catch((error) => ({ error })),
  ]);

  if (homeRes.error || awayRes.error) {
    return {
      result: null,
      reason: 'fetch-error',
      meta,
      detail: compactObject({
        homeError: homeRes.error ? homeRes.error.message || String(homeRes.error) : undefined,
        awayError: awayRes.error ? awayRes.error.message || String(awayRes.error) : undefined,
      }),
    };
  }

  const homeStats = unwrapTeamStats(homeRes.res);
  const awayStats = unwrapTeamStats(awayRes.res);

  if (!homeStats || !awayStats) {
    return {
      result: null,
      reason: 'missing-team-stats',
      meta,
      detail: { haveHome: !!homeStats, haveAway: !!awayStats },
    };
  }

  const homeFeatures = deriveTeamFeatures(homeStats, 'home');
  const awayFeatures = deriveTeamFeatures(awayStats, 'away');

  const computed = computeProbabilitiesFromFeatures(homeFeatures, awayFeatures);
  if (!computed) {
    return { result: null, reason: 'insufficient-derived-features', meta };
  }

  return { result: computed, meta };
}

async function deriveSimpleModel(fixture) {
  const fallback = computeFallbackModel();
  const meta = extractFixtureMeta(fixture || {});
  try {
    const { result, reason, detail } = await computeModelProbs(fixture, meta);
    if (result) {
      return result;
    }
    const payload = compactObject({
      reason: reason || 'unknown',
      fixture_id: meta.fixtureId,
      league_id: meta.leagueId,
      season: meta.season,
      home_id: meta.homeId,
      away_id: meta.awayId,
      home: meta.homeName,
      away: meta.awayName,
    });
    if (detail && Object.keys(detail).length) payload.detail = detail;
    console.warn('[model:fallback]', payload);
  } catch (err) {
    const payload = compactObject({
      reason: 'error',
      error: err?.message || String(err),
      fixture_id: meta.fixtureId,
      league_id: meta.leagueId,
      season: meta.season,
      home_id: meta.homeId,
      away_id: meta.awayId,
      home: meta.homeName,
      away: meta.awayName,
    });
    console.warn('[model:fallback]', payload);
  }
  return fallback;
}

async function makePickFromRaw({
  fixture_id,
  league,
  teams,
  datetime_local,
  rawSourceMeta = {},
}) {
  const simple = await deriveSimpleModel();
  return {
    fixture_id,
    league,
    teams,
    venue: { name: null },
    datetime_local,
    model_probs: simple.model_probs,
    predicted: simple.predicted,
    confidence: simple.confidence,
    rankScore: simple.confidence,
    btts_probability: simple.btts_probability,
    over25_probability: simple.over25_probability,
    ...rawSourceMeta,
  };
}

// Fetch with retry/backoff for SportMonks
async function fetchWithRetry(url) {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          throw new Error(`Invalid JSON from SportMonks: ${e.message}`);
        }
        return { ok: true, status: res.status, data: parsed, rawText: text };
      } else if (res.status >= 500 && res.status < 600) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 100;
        await sleep(backoff);
        attempt += 1;
        continue;
      } else {
        return { ok: false, status: res.status, data: null, rawText: text };
      }
    } catch (err) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 100;
      await sleep(backoff);
      attempt += 1;
      if (attempt >= MAX_RETRIES) {
        return { ok: false, status: null, data: null, rawText: err.message, error: err };
      }
    }
  }
  return { ok: false, status: null, data: null, rawText: 'max retries exceeded' };
}

// SportMonks source
async function trySportMonks(dateStr) {
  const url = `${SPORTMONKS_BASE}/fixtures/date/${encodeURIComponent(
    dateStr
  )}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(
    process.env.SPORTMONKS_KEY || ''
  )}&tz=UTC`;
  const result = await fetchWithRetry(url);
  if (result.ok && Array.isArray(result.data?.data)) {
    const fixtures = (result.data.data || []).slice(0, 10);
    const picks = await Promise.all(
      fixtures.map(async (f) => {
        const simple = await deriveSimpleModel(f);
        return {
          fixture_id: f.id,
          league: {
            id: f.league?.data?.id,
            name: f.league?.data?.name,
          },
          teams: {
            home: {
              id: f.localTeam?.data?.id,
              name: f.localTeam?.data?.name,
            },
            away: {
              id: f.visitorTeam?.data?.id,
              name: f.visitorTeam?.data?.name,
            },
          },
          venue: { name: null },
          datetime_local: f.time || null,
          model_probs: simple.model_probs,
          predicted: simple.predicted,
          confidence: simple.confidence,
          rankScore: simple.confidence,
          btts_probability: simple.btts_probability,
          over25_probability: simple.over25_probability,
        };
      })
    );

    return {
      picks,
      debug: {
        source: 'sportmonks',
        date: dateStr,
        total_fetched: picks.length,
        raw_source: result.data,
        request_url: url,
        status: result.status,
      },
    };
  } else {
    return {
      picks: null,
      error: true,
      debug: {
        source: 'sportmonks',
        date: dateStr,
        reason: 'failed',
        fetch_error: {
          status: result.status,
          raw: result.rawText,
        },
        request_url: url,
      },
    };
  }
}

// API-Football fallback
async function tryAPIFootball(dateStr) {
  const url = `${API_FOOTBALL_BASE}/fixtures?date=${encodeURIComponent(dateStr)}`;
  const headers = {
    'x-apisports-key': process.env.API_FOOTBALL_KEY || '',
  };
  try {
    const res = await fetch(url, { headers });
    const json = await res.json();
    if (res.ok && Array.isArray(json.response)) {
      const fixtures = json.response.slice(0, 10);
      const picks = await Promise.all(
        fixtures.map(async (f) => {
          const simple = await deriveSimpleModel(f);
          return {
            fixture_id: f.fixture?.id ?? null,
            league: {
              id: f.league?.id ?? null,
              name: f.league?.name ?? null,
            },
            teams: {
              home: {
                id: f.teams?.home?.id ?? null,
                name: f.teams?.home?.name ?? null,
              },
              away: {
                id: f.teams?.away?.id ?? null,
                name: f.teams?.away?.name ?? null,
              },
            },
            venue: { name: f.fixture?.venue?.name || null },
            datetime_local: {
              date_time: f.fixture?.date,
              timestamp: f.fixture?.timestamp,
              timezone: f.fixture?.timezone,
            },
            model_probs: simple.model_probs,
            predicted: simple.predicted,
            confidence: simple.confidence,
            rankScore: simple.confidence,
            btts_probability: simple.btts_probability,
            over25_probability: simple.over25_probability,
          };
        })
      );
      return {
        picks,
        debug: {
          source: 'api-football',
          date: dateStr,
          total_fetched: picks.length,
          raw_source: json,
          request_url: url,
          status: res.status,
        },
      };
    }
  } catch (e) {
    // fall through to error return
  }
  return {
    picks: null,
    error: true,
    debug: {
      source: 'api-football',
      date: dateStr,
      reason: 'failed or empty',
      request_url: url,
    },
  };
}

// Football-Data.org fallback
async function tryFootballData(dateStr) {
  // dateFrom and dateTo same day
  const url = `${FOOTBALL_DATA_BASE}/matches?dateFrom=${encodeURIComponent(
    dateStr
  )}&dateTo=${encodeURIComponent(dateStr)}`;
  const headers = {
    'X-Auth-Token': process.env.FOOTBALL_DATA_KEY || '',
  };
  try {
    const res = await fetch(url, { headers });
    const json = await res.json();
    if (res.ok && Array.isArray(json.matches)) {
      const fixtures = json.matches.slice(0, 10);
      const picks = await Promise.all(
        fixtures.map(async (f) => {
          const simple = await deriveSimpleModel(f);
          return {
            fixture_id: f.id,
            league: {
              id: f.competition?.id ?? null,
              name: f.competition?.name ?? null,
            },
            teams: {
              home: {
                id: f.homeTeam?.id ?? null,
                name: f.homeTeam?.name ?? null,
              },
              away: {
                id: f.awayTeam?.id ?? null,
                name: f.awayTeam?.name ?? null,
              },
            },
            venue: { name: null },
            datetime_local: {
              date_time: f.utcDate,
            },
            model_probs: simple.model_probs,
            predicted: simple.predicted,
            confidence: simple.confidence,
            rankScore: simple.confidence,
            btts_probability: simple.btts_probability,
            over25_probability: simple.over25_probability,
          };
        })
      );
      return {
        picks,
        debug: {
          source: 'football-data',
          date: dateStr,
          total_fetched: picks.length,
          raw_source: json,
          request_url: url,
          status: res.status,
        },
      };
    }
  } catch (e) {
    // fall through
  }
  return {
    picks: null,
    error: true,
    debug: {
      source: 'football-data',
      date: dateStr,
      reason: 'failed or empty',
      request_url: url,
    },
  };
}

// Master selector with fallbacks
export async function selectMatchesForDate(rawDateStr) {
  try {
    const normalized = normalizeDateInput(rawDateStr);
    const date = normalized.used; // YYYY-MM-DD

    // 1. Try SportMonks
    const sm = await trySportMonks(date);
    if (sm.picks && sm.picks.length > 0) {
      lastGood = {
        timestamp: Date.now(),
        picks: sm.picks,
        debug: sm.debug,
      };
      return {
        picks: sm.picks,
        debug: sm.debug,
      };
    }

    // 2. If SportMonks failed, but we have recent lastGood, use it
    const age = Date.now() - lastGood.timestamp;
    if (lastGood.picks && age < LAST_GOOD_TTL_MS) {
      return {
        picks: lastGood.picks,
        debug: {
          source: 'fallback-cache',
          date,
          total_fetched: lastGood.picks.length,
          reason: 'using last good cached picks because primary failed',
          cached_age_ms: age,
          original_debug: lastGood.debug,
        },
      };
    }

    // 3. Try API-Football
    const af = await tryAPIFootball(date);
    if (af.picks && af.picks.length > 0) {
      lastGood = {
        timestamp: Date.now(),
        picks: af.picks,
        debug: af.debug,
      };
      return {
        picks: af.picks,
        debug: af.debug,
      };
    }

    // 4. Try Football-Data.org
    const fd = await tryFootballData(date);
    if (fd.picks && fd.picks.length > 0) {
      lastGood = {
        timestamp: Date.now(),
        picks: fd.picks,
        debug: fd.debug,
      };
      return {
        picks: fd.picks,
        debug: fd.debug,
      };
    }

    // 5. Nothing worked
    return {
      picks: [],
      debug: {
        source: 'all-failed',
        date,
        reasons: {
          sportmonks: sm.debug,
          apiFootball: af.debug,
          footballData: fd.debug,
        },
      },
      sourceUsed: 'none',
      total_fetched: 0,
    };
  } catch (err) {
    console.error('selectMatchesForDate master error:', err);
    return {
      picks: [],
      debug: {
        error: err.message,
        original_input: rawDateStr,
      },
      sourceUsed: 'internal-error',
      total_fetched: 0,
    };
  }
}
