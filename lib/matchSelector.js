// FILE: lib/matchSelector.js

const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const LAST_GOOD_TTL_MS = 10 * 60 * 1000; // 10 minuta

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

// Placeholder simple model: 1X2 + BTTS + Over 2.5
function deriveSimpleModel(fixture) {
  const home = 0.45;
  const draw = 0.25;
  const away = 0.30;
  let predicted = 'home';
  if (away > home && away > draw) predicted = 'away';
  else if (draw > home && draw > away) predicted = 'draw';
  const probs = { home, draw, away };
  const sorted = Object.entries(probs)
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v);
  const gap = sorted[0].v - sorted[1].v;
  const confidence = Math.min(100, Math.round((gap / 0.5) * 100));
  return {
    model_probs: probs,
    predicted,
    confidence,
    btts_probability: 0.4,
    over25_probability: 0.32,
  };
}

// Generic mapping helper to unify different source shapes into pick
function makePickFromRaw({
  fixture_id,
  league,
  teams,
  datetime_local,
  rawSourceMeta = {},
}) {
  const simple = deriveSimpleModel();
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
    const picks = fixtures.map((f) => {
      const simple = deriveSimpleModel(f);
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
    });

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
      const picks = fixtures.map((f) => {
        const simple = deriveSimpleModel(f);
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
      });
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
      const picks = fixtures.map((f) => {
        const simple = deriveSimpleModel(f);
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
      });
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
