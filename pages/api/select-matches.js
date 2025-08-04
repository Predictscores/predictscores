// pages/api/select-matches.js

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';

const CACHE_TTL_MS = 1000 * 60 * 60; // 1h per date
const cache = {}; // keyed by date string YYYY-MM-DD

const weightsForm = [0.4, 0.3, 0.15, 0.1, 0.05]; // last 5 matches

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function poissonProb(k, lambda) {
  // e^-λ * λ^k / k!
  let res = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    res *= lambda / i;
  }
  return res;
}
function poissonCdf(k, lambda) {
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += poissonProb(i, lambda);
  return sum;
}

// convert UTC timestamp to Europe/Belgrade local formatted
function formatLocal(dtStr) {
  try {
    const d = new Date(dtStr);
    return d.toLocaleString('en-GB', {
      timeZone: 'Europe/Belgrade',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return dtStr;
  }
}

async function fetchFromAPIFootball(path, params = {}) {
  const url = new URL(`${API_FOOTBALL_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = {
    'x-apisports-key': process.env.API_FOOTBALL_KEY || '',
    'x-apisports-host': 'v3.football.api-sports.io',
  };
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API-Football ${res.status} ${text}`);
  }
  return res.json();
}

async function fetchFormAPIFootball(teamId) {
  try {
    const json = await fetchFromAPIFootball('/fixtures', { team: teamId, last: 5 });
    const arr = json.response || [];
    if (arr.length === 0) return { formScore: 0.5, avgGoalsFor: 1, avgGoalsAgainst: 1 };
    // form: win=1, draw=0.5, loss=0
    const formVals = arr.map((f) => {
      const home = f.teams.home.id;
      const away = f.teams.away.id;
      const goalsHome = f.goals.home;
      const goalsAway = f.goals.away;
      let result = 0;
      if (f.teams.home.id === teamId) {
        if (goalsHome > goalsAway) result = 1;
        else if (goalsHome === goalsAway) result = 0.5;
        else result = 0;
      } else if (f.teams.away.id === teamId) {
        if (goalsAway > goalsHome) result = 1;
        else if (goalsAway === goalsHome) result = 0.5;
        else result = 0;
      }
      return {
        result,
        goalsFor: f.teams.home.id === teamId ? goalsHome : goalsAway,
        goalsAgainst: f.teams.home.id === teamId ? goalsAway : goalsHome,
      };
    });
    // Weighted form score
    let formScore = 0;
    for (let i = 0; i < formVals.length; i++) {
      const w = weightsForm[i] || 0;
      formScore += formVals[i].result * w;
    }
    // fallback normalization if no weights sum to 1
    // average goals
    const avgGoalsFor =
      formVals.reduce((sum, it) => sum + it.goalsFor, 0) / formVals.length || 1;
    const avgGoalsAgainst =
      formVals.reduce((sum, it) => sum + it.goalsAgainst, 0) / formVals.length || 1;
    return {
      formScore: clamp(formScore, 0, 1),
      avgGoalsFor,
      avgGoalsAgainst,
    };
  } catch (e) {
    console.warn('fetchFormAPIFootball failed', e.message);
    return { formScore: 0.5, avgGoalsFor: 1, avgGoalsAgainst: 1 };
  }
}

async function fetchMatchesFromAPIFootball(date) {
  try {
    // date in YYYY-MM-DD
    const json = await fetchFromAPIFootball('/fixtures', { date });
    const fixtures = (json.response || []).map((f) => {
      return {
        fixture_id: f.fixture.id,
        league: {
          id: f.league.id,
          name: f.league.name,
        },
        teams: {
          home: { id: f.teams.home.id, name: f.teams.home.name },
          away: { id: f.teams.away.id, name: f.teams.away.name },
        },
        datetime_utc: f.fixture.date,
      };
    });
    return { list: fixtures, source: 'api-football', raw: json };
  } catch (e) {
    console.warn('fetchMatchesFromAPIFootball failed', e.message);
    return { list: [], source: 'api-football', error: e.message };
  }
}

async function fetchMatchesFromFootballData(date) {
  try {
    const url = `${FOOTBALL_DATA_BASE}/matches?dateFrom=${date}&dateTo=${date}`;
    const res = await fetch(url, {
      headers: {
        'X-Auth-Token': process.env.FOOTBALL_DATA_KEY || '',
      },
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Football-Data.org ${res.status} ${txt}`);
    }
    const json = await res.json();
    const fixtures = (json.matches || []).map((m) => {
      return {
        fixture_id: m.id,
        league: {
          id: m.competition?.id,
          name: m.competition?.name,
        },
        teams: {
          home: { id: m.homeTeam?.id, name: m.homeTeam?.name },
          away: { id: m.awayTeam?.id, name: m.awayTeam?.name },
        },
        datetime_utc: m.utcDate,
      };
    });
    return { list: fixtures, source: 'football-data', raw: json };
  } catch (e) {
    console.warn('fetchMatchesFromFootballData failed', e.message);
    return { list: [], source: 'football-data', error: e.message };
  }
}

async function fetchMatchesFromSportMonks(date) {
  try {
    // SportMonks date format might be YYYY-MM-DD
    const token = process.env.SPORTMONKS_KEY || '';
    const url = `${SPORTMONKS_BASE}/fixtures/date/${date}?api_token=${token}&include=localTeam,visitorTeam,league`;
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`SportMonks ${res.status} ${txt}`);
    }
    const json = await res.json();
    const fixtures = (json.data || []).map((f) => {
      // localTeam & visitorTeam included
      return {
        fixture_id: f.id,
        league: {
          id: f.league?.data?.id,
          name: f.league?.data?.name,
        },
        teams: {
          home: {
            id: f.localteam_id,
            name: f.localTeam?.data?.name || 'Home',
          },
          away: {
            id: f.visitorteam_id,
            name: f.visitorTeam?.data?.name || 'Away',
          },
        },
        datetime_utc: f.time?.starting_at?.date_time_utc || f.starting_at, // best effort
      };
    });
    return { list: fixtures, source: 'sportmonks', raw: json };
  } catch (e) {
    console.warn('fetchMatchesFromSportMonks failed', e.message);
    return { list: [], source: 'sportmonks', error: e.message };
  }
}

function compute1x2Probabilities(rawHome, rawAway) {
  // home advantage already baked into rawHome if applied
  // convert to exp scale
  const eHome = Math.exp(rawHome);
  const eAway = Math.exp(rawAway);
  const total = eHome + eAway;
  const pHomeRaw = eHome / total;
  const pAwayRaw = eAway / total;
  const drawStrength = 0.2; // fixed draw baseline
  const pHome = (1 - drawStrength) * pHomeRaw;
  const pAway = (1 - drawStrength) * pAwayRaw;
  const pDraw = drawStrength;
  // normalize just in case (should sum to 1)
  const sum = pHome + pDraw + pAway;
  return {
    home: pHome / sum,
    draw: pDraw / sum,
    away: pAway / sum,
  };
}

export default async function handler(req, res) {
  try {
    // Determine date in Europe/Belgrade for "today"
    const now = new Date();
    const belgradeDate = now.toLocaleString('en-CA', { timeZone: 'Europe/Belgrade' }); // YYYY-MM-DD,...
    const dateOnly = belgradeDate.split(',')[0]; // ISO-ish YYYY-MM-DD

    // Cache key
    if (cache[dateOnly] && Date.now() - cache[dateOnly].timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache[dateOnly].data);
    }

    // 1. Fetch matches - try API-Football, then SportMonks, then Football-Data
    let matchesResult = await fetchMatchesFromAPIFootball(dateOnly);
    if (!matchesResult.list || matchesResult.list.length === 0) {
      matchesResult = await fetchMatchesFromSportMonks(dateOnly);
    }
    if (!matchesResult.list || matchesResult.list.length === 0) {
      matchesResult = await fetchMatchesFromFootballData(dateOnly);
    }

    const allFixtures = matchesResult.list || [];

    // For each fixture, compute features
    const picks = [];
    for (const f of allFixtures) {
      try {
        // Get form + avg goals for home and away (API-Football only if possible)
        let homeForm = { formScore: 0.5, avgGoalsFor: 1, avgGoalsAgainst: 1 };
        let awayForm = { formScore: 0.5, avgGoalsFor: 1, avgGoalsAgainst: 1 };
        if (matchesResult.source === 'api-football') {
          [homeForm, awayForm] = await Promise.all([
            fetchFormAPIFootball(f.teams.home.id),
            fetchFormAPIFootball(f.teams.away.id),
          ]);
        }

        // Raw strength: form + home advantage
        const rawHome = homeForm.formScore + 0.1; // home adv
        const rawAway = awayForm.formScore;

        const probs = compute1x2Probabilities(rawHome, rawAway);

        // Confidence: difference between top two
        const sorted = Object.entries(probs)
          .map(([k, v]) => ({ k, v }))
          .sort((a, b) => b.v - a.v);
        const max = sorted[0].v;
        const second = sorted[1].v;
        let confidence = clamp((max - second) * 1.5, 0, 1); // scale
        confidence = Number((confidence * 100).toFixed(1));

        // Predicted outcome
        let predicted = sorted[0].k; // 'home'|'draw'|'away'

        // BTTS: using Poisson approximation for each team scoring at least one
        const lambdaHome = homeForm.avgGoalsFor;
        const lambdaAway = awayForm.avgGoalsFor;
        const probHomeScores = 1 - Math.exp(-lambdaHome);
        const probAwayScores = 1 - Math.exp(-lambdaAway);
        const bttsProb = clamp(probHomeScores * probAwayScores, 0, 1);

        // Over/Under 2.5: approximate as Poisson with lambda = sum of avg goals
        const expectedTotal = homeForm.avgGoalsFor + awayForm.avgGoalsFor;
        const over25Prob = 1 - poissonCdf(2, expectedTotal); // P(X > 2)

        // Compose pick
        picks.push({
          fixture_id: f.fixture_id,
          league: f.league,
          teams: f.teams,
          venue: { name: null }, // placeholder
          datetime_local: formatLocal(f.datetime_utc),
          model_probs: {
            home: Number(probs.home.toFixed(3)),
            draw: Number(probs.draw.toFixed(3)),
            away: Number(probs.away.toFixed(3)),
          },
          predicted,
          confidence,
          btts_probability: Number(bttsProb.toFixed(3)),
          over25_probability: Number(over25Prob.toFixed(3)),
          rankScore: confidence, // initial ranking
        });
      } catch (inner) {
        console.warn('per-fixture compute error', inner.message);
      }
    }

    // Sort picks by rankScore descending (confidence)
    picks.sort((a, b) => b.rankScore - a.rankScore);

    const payload = {
      picks: picks.slice(0, 10), // top 10
      debug: {
        date: dateOnly,
        sourceUsed: matchesResult.source,
        total_fetched: allFixtures.length,
        raw_source: matchesResult.raw || null,
      },
    };

    cache[dateOnly] = {
      timestamp: Date.now(),
      data: payload,
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('select-matches error:', err);
    return res.status(500).json({
      error: 'internal',
      message: err.message,
    });
  }
}
