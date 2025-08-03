// FILE: pages/api/select-matches.js

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
if (!API_FOOTBALL_KEY) {
  console.warn('Missing API_FOOTBALL_KEY in env');
}

// Simple in-memory caches (will reset on cold start)
const fixturesCache = {
  // key: date string YYYY-MM-DD -> { timestamp, data }
};
const leagueStandingsCache = {
  // key: leagueId-season -> { timestamp, data }
};
const teamFormCache = {
  // key: teamId -> { timestamp, form: { lastResults: [...], computed } }
};

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes

const fetchWithRetry = async (url, options = {}, retries = 2) => {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 500));
        return fetchWithRetry(url, options, retries - 1);
      }
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 500));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw e;
  }
};

const getTodayDateStr = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getFixturesForDate = async (dateStr) => {
  if (
    fixturesCache[dateStr] &&
    Date.now() - fixturesCache[dateStr].timestamp < CACHE_TTL_MS
  ) {
    return fixturesCache[dateStr].data;
  }

  const url = `https://v3.football.api-sports.io/fixtures?date=${dateStr}&timezone=UTC`;
  const payload = await fetchWithRetry(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY,
    },
  });

  const fixtures = payload.response || [];
  fixturesCache[dateStr] = {
    timestamp: Date.now(),
    data: fixtures,
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

  const url = `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`;
  const payload = await fetchWithRetry(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY,
    },
  });

  const standings = payload.response?.[0]?.league?.standings?.[0] || [];
  leagueStandingsCache[cacheKey] = {
    timestamp: Date.now(),
    data: standings,
  };
  return standings;
};

// Get last 5 finished results for a team (form)
const getTeamForm = async (teamId) => {
  if (
    teamFormCache[teamId] &&
    Date.now() - teamFormCache[teamId].timestamp < CACHE_TTL_MS
  ) {
    return teamFormCache[teamId].form;
  }

  // last=5 gives last 5 fixtures of any status, filter finished
  const url = `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=8&timezone=UTC`;
  const payload = await fetchWithRetry(url, {
    headers: {
      'x-apisports-key': API_FOOTBALL_KEY,
    },
  });

  let fixtures = payload.response || [];
  // Retain only finished (FT) matches, take most recent 5
  fixtures = fixtures
    .filter((f) => f.fixture.status.short === 'FT')
    .sort(
      (a, b) =>
        new Date(b.fixture.date).getTime() - new Date(a.fixture.date).getTime()
    )
    .slice(0, 5);

  // Compute weighted form: weights [5,4,3,2,1]
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
    // else 0

    totalScore += weight * points;
    maxPossible += weight * 3;
  });

  // normalized 0..1
  const formValue = maxPossible > 0 ? totalScore / maxPossible : 0;

  const form = {
    formValue,
    recentMatches: fixtures.map((m) => ({
      opponent: m.teams.home.id === teamId ? m.teams.away : m.teams.home,
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

  teamFormCache[teamId] = {
    timestamp: Date.now(),
    form,
  };
  return form;
};

// Convert UTC ISO to Europe/Belgrade display string
const toLocalTimeString = (utcDateStr) => {
  try {
    const d = new Date(utcDateStr);
    // options
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

const compute1X2Model = async (fixture) => {
  // Weights for components
  const FORM_WEIGHT = 0.5;
  const TABLE_WEIGHT = 0.3;
  const HOME_ADVANTAGE = 0.08; // boost for home
  const DRAW_BASE = 0.18; // baseline draw probability

  const leagueId = fixture.league.id;
  const season = fixture.league.season;

  // Get standings
  const standings = await getLeagueStandings(leagueId, season);
  // Map team to position score
  const maxPosition = standings.length;
  const getTableScore = (teamId) => {
    const entry = standings.find((s) => s.team.id === teamId);
    if (!entry) return 0.5; // neutral if missing
    const pos = entry.rank; // 1-based
    // convert to 0..1 where better rank => higher
    return (maxPosition - pos) / (maxPosition - 1 || 1);
  };

  // Form values
  const homeForm = await getTeamForm(fixture.teams.home.id);
  const awayForm = await getTeamForm(fixture.teams.away.id);

  // Strength proxies
  const strengthHomeRaw =
    homeForm.formValue * FORM_WEIGHT + getTableScore(fixture.teams.home.id) * TABLE_WEIGHT + HOME_ADVANTAGE;
  const strengthAwayRaw =
    awayForm.formValue * FORM_WEIGHT + getTableScore(fixture.teams.away.id) * TABLE_WEIGHT;

  // Prevent zero
  const baseHome = Math.max(strengthHomeRaw, 0.0001);
  const baseAway = Math.max(strengthAwayRaw, 0.0001);
  const sumBase = baseHome + baseAway;

  // Probabilities without draw
  const probHomeNoDraw = baseHome / sumBase;
  const probAwayNoDraw = baseAway / sumBase;
  const probDraw = DRAW_BASE;

  // Scale home/away to fit remaining after draw
  const scaling = 1 - probDraw;
  const probHome = probHomeNoDraw * scaling;
  const probAway = probAwayNoDraw * scaling;

  // final normalization guard
  const total = probHome + probDraw + probAway;
  const normalizedHome = probHome / total;
  const normalizedDraw = probDraw / total;
  const normalizedAway = probAway / total;

  // Confidence measurement: difference between top two
  const probs = [
    { key: 'home', val: normalizedHome },
    { key: 'draw', val: normalizedDraw },
    { key: 'away', val: normalizedAway },
  ].sort((a, b) => b.val - a.val);
  const top = probs[0];
  const second = probs[1];
  const confidence = top.val - second.val; // range 0..1

  return {
    model_probs: {
      home: normalizedHome,
      draw: normalizedDraw,
      away: normalizedAway,
    },
    predicted: top.key, // 'home' | 'draw' | 'away'
    confidence, // difference
    topProbability: top.val,
  };
};

export default async function handler(req, res) {
  try {
    const today = getTodayDateStr();
    const fixtures = await getFixturesForDate(today);
    if (!fixtures || fixtures.length === 0) {
      return res.status(200).json({ picks: [], message: 'No fixtures today' });
    }

    // Filter only matches with valid teams and upcoming or very recent (could filter by status if needed)
    const candidateFixtures = fixtures.filter((f) => {
      // Only scheduled or live or just started
      // We'll include those with fixture timestamp >= now - 2h to not miss recently started
      return true;
    });

    // For each fixture, compute model
    const enriched = [];
    for (const f of candidateFixtures) {
      try {
        const model = await compute1X2Model(f);
        // Score to rank: use topProbability * (1 + confidence) to favor both high prob and clear confidence
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
          venue: f.fixture.venue,
          datetime_utc: f.fixture.date,
          datetime_local: toLocalTimeString(f.fixture.date),
          model,
          rankScore,
        });
      } catch (e) {
        console.error('Model compute error for fixture', f.fixture.id, e.message);
      }
    }

    // Sort by rankScore descending
    enriched.sort((a, b) => b.rankScore - a.rankScore);
    const top10 = enriched.slice(0, 10);

    return res.status(200).json({
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
    });
  } catch (err) {
    console.error('select-matches error', err);
    res.status(500).json({ error: err.message || 'unknown error' });
  }
}
