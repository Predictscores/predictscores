// FILE: lib/matchSelector.js

// Assumes Node 18+ (global fetch)
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY;

const CACHE_TTL_MS = 1000 * 60 * 30; // 30m

// Simple in-module caches
const fixturesCache = {};
const leagueStandingsCache = {};
const teamFormCache = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchWithRetry = async (url, options = {}, retries = 2) => {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      if (retries > 0) {
        await sleep(500);
        return fetchWithRetry(url, options, retries - 1);
      }
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    if (retries > 0) {
      await sleep(500);
      return fetchWithRetry(url, options, retries - 1);
    }
    throw e;
  }
};

const getTodayDateStr = (override) => {
  if (override) return override;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toLocalTimeString = (utcDateStr) => {
  try {
    const d = new Date(utcDateStr);
    return d.toLocaleString('en-GB', {
      timeZone: 'Europe/Belgrade',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    });
  } catch {
    return utcDateStr;
  }
};

/* === API-Football helpers === */
const getFixturesFromApiFootball = async (dateStr) => {
  if (
    fixturesCache[dateStr] &&
    Date.now() - fixturesCache[dateStr].timestamp < CACHE_TTL_MS &&
    fixturesCache[dateStr].source === 'api-football'
  ) {
    return fixturesCache[dateStr].data;
  }
  if (!API_FOOTBALL_KEY) {
    throw new Error('Missing API_FOOTBALL_KEY');
  }
  const url = `https://v3.football.api-sports.io/fixtures?date=${dateStr}&timezone=UTC`;
  const payload = await fetchWithRetry(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  const fixtures = payload.response || [];
  fixturesCache[dateStr] = {
    timestamp: Date.now(),
    data: fixtures,
    source: 'api-football',
    raw: payload,
  };
  return fixtures;
};

const getLeagueStandings = async (leagueId, season) => {
  const cacheKey = `${leagueId}-${season}`;
  if (
    leagueStandingsCache[cacheKey] &&
    Date.now() - leagueStandingsCache[cacheKey].timestamp < CACHE_TTL_MS
  ) {
    return leagueStandingsCache[cacheKey].data;
  }
  if (!API_FOOTBALL_KEY) {
    return [];
  }
  const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`;
  const payload = await fetchWithRetry(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  const standings = payload.response?.[0]?.league?.standings?.[0] || [];
  leagueStandingsCache[cacheKey] = {
    timestamp: Date.now(),
    data: standings,
  };
  return standings;
};

const getTeamForm = async (teamId) => {
  if (
    teamFormCache[teamId] &&
    Date.now() - teamFormCache[teamId].timestamp < CACHE_TTL_MS
  ) {
    return teamFormCache[teamId].form;
  }
  if (!API_FOOTBALL_KEY) {
    return { formValue: 0, recentMatches: [] };
  }
  const url = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=8&timezone=UTC`;
  const payload = await fetchWithRetry(url, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY },
  });
  let fixtures = payload.response || [];
  fixtures = fixtures
    .filter((f) => f.fixture.status.short === 'FT')
    .sort(
      (a, b) =>
        new Date(b.fixture.date).getTime() - new Date(a.fixture.date).getTime()
    )
    .slice(0, 5);

  const weights = [5, 4, 3, 2, 1];
  let totalScore = 0;
  let maxPossible = 0;
  fixtures.forEach((match, idx) => {
    const weight = weights[idx] || 1;
    const isHome = match.teams.home.id === teamId;
    const goalsFor = isHome
      ? match.score.fulltime.home
      : match.score.fulltime.away;
    const goalsAgainst = isHome
      ? match.score.fulltime.away
      : match.score.fulltime.home;
    let points = 0;
    if (goalsFor > goalsAgainst) points = 3;
    else if (goalsFor === goalsAgainst) points = 1;
    totalScore += weight * points;
    maxPossible += weight * 3;
  });
  const formValue = maxPossible > 0 ? totalScore / maxPossible : 0;
  const form = {
    formValue,
    recentMatches: fixtures.map((m) => ({
      opponent:
        m.teams.home.id === teamId ? m.teams.away : m.teams.home,
      result:
        (m.teams.home.id === teamId
          ? m.score.fulltime.home
          : m.score.fulltime.away) >
        (m.teams.home.id === teamId
          ? m.score.fulltime.away
          : m.score.fulltime.home)
          ? 'W'
          : (m.teams.home.id === teamId
              ? m.score.fulltime.home
              : m.score.fulltime.away) ===
            (m.teams.home.id === teamId
              ? m.score.fulltime.away
              : m.score.fulltime.home)
          ? 'D'
          : 'L',
    })),
  };
  teamFormCache[teamId] = { timestamp: Date.now(), form };
  return form;
};

/* === Fallback: football-data.org === */
const getFixturesFromFootballData = async (dateStr) => {
  const cacheKey = `fd-${dateStr}`;
  if (
    fixturesCache[cacheKey] &&
    Date.now() - fixturesCache[cacheKey].timestamp < CACHE_TTL_MS &&
    fixturesCache[cacheKey].source === 'football-data'
  ) {
    return fixturesCache[cacheKey].data;
  }
  if (!FOOTBALL_DATA_KEY) {
    return [];
  }
  const url = `https://api.football-data.org/v4/matches?dateFrom=${dateStr}&dateTo=${dateStr}`;
  const payload = await fetchWithRetry(url, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY },
  });
  const matches = payload.matches || [];
  const normalized = matches.map((m) => ({
    fixture: {
      id: m.id,
      date: m.utcDate,
      venue: { name: m.venue || null },
    },
    league: {
      id: m.competition?.id,
      name: m.competition?.name,
      country: m.competition?.area?.name,
      season: m.season?.startDate
        ? new Date(m.season.startDate).getFullYear()
        : new Date().getFullYear(),
    },
    teams: {
      home: { id: m.homeTeam.id, name: m.homeTeam.name },
      away: { id: m.awayTeam.id, name: m.awayTeam.name },
    },
  }));
  fixturesCache[cacheKey] = {
    timestamp: Date.now(),
    data: normalized,
    source: 'football-data',
    raw: payload,
  };
  return normalized;
};

const compute1X2Model = async (fixture) => {
  const FORM_WEIGHT = 0.5;
  const TABLE_WEIGHT = 0.3;
  const HOME_ADVANTAGE = 0.08;
  const DRAW_BASE = 0.18;

  const leagueId = fixture.league.id;
  const season = fixture.league.season;

  const standings = await getLeagueStandings(leagueId, season);
  const maxPosition = standings.length;
  const getTableScore = (teamId) => {
    const entry = standings.find((s) => s.team.id === teamId);
    if (!entry) return 0.5;
    const pos = entry.rank;
    return (maxPosition - pos) / (maxPosition - 1 || 1);
  };

  const homeForm = await getTeamForm(fixture.teams.home.id);
  const awayForm = await getTeamForm(fixture.teams.away.id);

  const strengthHomeRaw =
    homeForm.formValue * FORM_WEIGHT +
    getTableScore(fixture.teams.home.id) * TABLE_WEIGHT +
    HOME_ADVANTAGE;
  const strengthAwayRaw =
    awayForm.formValue * FORM_WEIGHT +
    getTableScore(fixture.teams.away.id) * TABLE_WEIGHT;

  const baseHome = Math.max(strengthHomeRaw, 0.0001);
  const baseAway = Math.max(strengthAwayRaw, 0.0001);
  const sumBase = baseHome + baseAway;

  const probHomeNoDraw = baseHome / sumBase;
  const probAwayNoDraw = baseAway / sumBase;
  const probDraw = DRAW_BASE;

  const scaling = 1 - probDraw;
  const probHome = probHomeNoDraw * scaling;
  const probAway = probAwayNoDraw * scaling;

  const total = probHome + probDraw + probAway;
  const normalizedHome = probHome / total;
  const normalizedDraw = probDraw / total;
  const normalizedAway = probAway / total;

  const probs = [
    { key: 'home', val: normalizedHome },
    { key: 'draw', val: normalizedDraw },
    { key: 'away', val: normalizedAway },
  ].sort((a, b) => b.val - a.val);
  const top = probs[0];
  const second = probs[1];
  const confidence = top.val - second.val;

  return {
    model_probs: {
      home: normalizedHome,
      draw: normalizedDraw,
      away: normalizedAway,
    },
    predicted: top.key,
    confidence,
    topProbability: top.val,
  };
};

const computeFallback1X2Model = async (fixture) => {
  const HOME_ADVANTAGE = 0.08;
  const BASE_DRAW = 0.25;

  let probHome = 0.5 + HOME_ADVANTAGE;
  let probAway = 0.25 - HOME_ADVANTAGE / 2;
  let probDraw = BASE_DRAW;

  const total = probHome + probDraw + probAway;
  probHome /= total;
  probDraw /= total;
  probAway /= total;

  const probs = [
    { key: 'home', val: probHome },
    { key: 'draw', val: probDraw },
    { key: 'away', val: probAway },
  ].sort((a, b) => b.val - a.val);
  const top = probs[0];
  const second = probs[1];
  const confidence = top.val - second.val;

  return {
    model_probs: {
      home: probHome,
      draw: probDraw,
      away: probAway,
    },
    predicted: top.key,
    confidence,
    topProbability: top.val,
  };
};

/**
 * Returns top N match picks for given date (YYYY-MM-DD or omitted for today)
 */
const getTopMatches = async (dateOverride) => {
  const dateStr = getTodayDateStr(dateOverride);

  // Try primary source
  let fixtures = [];
  let sourceUsed = '';
  let raw = null;
  try {
    const fromApi = await getFixturesFromApiFootball(dateStr);
    fixtures = fromApi;
    sourceUsed = 'api-football';
    raw = fixturesCache[dateStr]?.raw || null;
    // detect suspension error structure
    if (fixtures.length === 0 && raw?.errors) {
      throw new Error('API-Football suspended or error');
    }
  } catch (e) {
    // fallback
    const fromFD = await getFixturesFromFootballData(dateStr);
    fixtures = fromFD;
    sourceUsed = 'football-data';
    raw = fixturesCache[`fd-${dateStr}`]?.raw || null;
  }

  if (!fixtures || fixtures.length === 0) {
    return {
      picks: [],
      debug: {
        date: dateStr,
        sourceUsed,
        rawResponse: raw,
      },
    };
  }

  const enriched = [];
  for (const f of fixtures) {
    try {
      let model;
      if (sourceUsed === 'api-football') {
        model = await compute1X2Model(f);
      } else {
        model = await computeFallback1X2Model(f);
      }
      const rankScore = model.topProbability * (1 + model.confidence);
      enriched.push({
        fixture_id: f.fixture.id,
        league: {
          id: f.league.id,
          name: f.league.name,
          country: f.league.country,
        },
        teams: {
          home: f.teams.home,
          away: f.teams.away,
        },
        venue: f.fixture?.venue,
        datetime_utc: f.fixture?.date,
        datetime_local: toLocalTimeString(f.fixture?.date),
        model,
        rankScore,
      });
    } catch (e) {
      // swallow per-fixture errors
      console.warn('model error for fixture', f.fixture?.id, e.message || e);
    }
  }

  enriched.sort((a, b) => b.rankScore - a.rankScore);
  const top10 = enriched.slice(0, 10);

  return {
    picks: top10.map((p) => ({
      fixture_id: p.fixture_id,
      league: p.league,
      teams: p.teams,
      venue: p.venue,
      datetime_local: p.datetime_local,
      model_probs: p.model.model_probs,
      predicted: p.model.predicted,
      confidence: p.model.confidence,
      rankScore: p.rankScore,
    })),
    debug: {
      date: dateStr,
      sourceUsed,
      total_fetched: fixtures.length,
    },
  };
};

export { getTopMatches };
