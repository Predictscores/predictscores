// FILE: lib/matchSelector.js

const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500; // start backoff
const LAST_GOOD_TTL_MS = 10 * 60 * 1000; // 10 minuta fallback na poslednji dobar

// In-memory last good cache (per lambda lifetime)
let lastGood = {
  timestamp: 0,
  raw: null, // full result object
};

// Normalize incoming date string into YYYY-MM-DD; fallback to today
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

// Simple model for 1X2, BTTS, Over/Under 2.5 (placeholder)
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

  const btts_probability = 0.4;
  const over25_probability = 0.32;

  return {
    model_probs: probs,
    predicted,
    confidence,
    btts_probability,
    over25_probability,
  };
}

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
          // malformed JSON, treat as failure
          throw new Error(`Invalid JSON from SportMonks: ${e.message}`);
        }
        return { ok: true, status: res.status, data: parsed, rawText: text };
      } else if (res.status >= 500 && res.status < 600) {
        // server error, retry
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 100;
        await sleep(backoff);
        attempt += 1;
        continue;
      } else {
        // client error or other, do not retry further
        return { ok: false, status: res.status, data: null, rawText: text };
      }
    } catch (err) {
      // network or unexpected error: retry with backoff
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

export async function selectMatchesForDate(rawDateStr) {
  try {
    const normalized = normalizeDateInput(rawDateStr);
    const formatted = normalized.used; // YYYY-MM-DD

    const url = `${SPORTMONKS_BASE}/fixtures/date/${encodeURIComponent(
      formatted
    )}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(
      process.env.SPORTMONKS_KEY || ''
    )}&tz=UTC`;

    const fetchResult = await fetchWithRetry(url);

    if (fetchResult.ok && Array.isArray(fetchResult.data?.data)) {
      // success path
      const fixtures = (fetchResult.data.data || []).slice(0, 10); // cap to 10
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

      // update last good
      lastGood = {
        timestamp: Date.now(),
        raw: {
          picks,
          debug: {
            date: formatted,
            original_input: rawDateStr,
            normalized_date: formatted,
            sourceUsed: 'sportmonks',
            total_fetched: picks.length,
            raw_source: fetchResult.data,
            request_url: url,
            retries: MAX_RETRIES,
          },
        },
      };

      return {
        picks,
        debug: {
          date: formatted,
          original_input: rawDateStr,
          normalized_date: formatted,
          sourceUsed: 'sportmonks',
          total_fetched: picks.length,
          raw_source: fetchResult.data,
          request_url: url,
          retries: 'succeeded',
        },
      };
    } else {
      // failure / fallback path
      const fallbackAge = Date.now() - lastGood.timestamp;
      if (lastGood.raw && fallbackAge < LAST_GOOD_TTL_MS) {
        // return last good with a note
        return {
          picks: lastGood.raw.picks,
          debug: {
            date: formatted,
            original_input: rawDateStr,
            normalized_date: formatted,
            sourceUsed: 'sportmonks-fallback',
            total_fetched: lastGood.raw.picks.length,
            reason: 'using last successful cached result due to SportMonks failure',
            fetch_error: {
              status: fetchResult.status,
              raw: fetchResult.rawText,
            },
            fallback_age_ms: fallbackAge,
          },
        };
      }

      // no recent fallback available, return error info with empty picks
      return {
        picks: [],
        debug: {
          date: formatted,
          original_input: rawDateStr,
          normalized_date: formatted,
          sourceUsed: 'sportmonks',
          total_fetched: 0,
          error: 'Failed to fetch fixtures after retries',
          fetch_error: {
            status: fetchResult.status,
            raw: fetchResult.rawText,
          },
          request_url: url,
        },
      };
    }
  } catch (err) {
    console.error('selectMatchesForDate error:', err);
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
