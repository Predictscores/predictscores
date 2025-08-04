// FILE: lib/matchSelector.js

const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';

// Normalize incoming date string into YYYY-MM-DD; fallback to today (Europe/Belgrade offset not critical here)
function normalizeDateInput(input) {
  let d = null;

  if (input) {
    // try as-is
    d = new Date(input);
    if (isNaN(d)) {
      // try replacing hyphens with slashes (some engines parse better)
      d = new Date(input.replace(/-/g, '/'));
    }
  }

  if (!d || isNaN(d)) {
    d = new Date(); // today
  }

  // pad to YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    used: `${yyyy}-${mm}-${dd}`,
    asDate: d,
  };
}

// Simple model for 1X2, BTTS, Over/Under 2.5 with placeholder probabilities.
function deriveSimpleModel(fixture) {
  // placeholder probability logic (could be replaced later)
  const home = 0.45;
  const draw = 0.25;
  const away = 0.30;

  // pick highest for 1X2
  let predicted = 'home';
  if (away > home && away > draw) predicted = 'away';
  else if (draw > home && draw > away) predicted = 'draw';

  const probs = { home, draw, away };

  // confidence: gap between best and second best scaled
  const sorted = Object.entries(probs)
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v);
  const gap = sorted[0].v - sorted[1].v;
  const confidence = Math.min(100, Math.round((gap / 0.5) * 100)); // arbitrary scaling

  // BTTS / Over 2.5 placeholders (could later derive from team forms)
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

export async function selectMatchesForDate(rawDateStr) {
  try {
    const normalized = normalizeDateInput(rawDateStr);
    const formatted = normalized.used; // YYYY-MM-DD

    const url = `${SPORTMONKS_BASE}/fixtures/date/${encodeURIComponent(
      formatted
    )}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(
      process.env.SPORTMONKS_KEY || ''
    )}&tz=UTC`;

    // for debugging, capture the URL
    const fetchUrl = url;

    const res = await fetch(fetchUrl);
    const rawText = await res.text();
    if (!res.ok) {
      return {
        picks: [],
        debug: {
          error: `sportmonks fetch failed ${res.status}`,
          request_date_raw: rawDateStr,
          normalized_date: formatted,
          url: fetchUrl,
          raw: rawText,
        },
        sourceUsed: 'sportmonks',
        total_fetched: 0,
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return {
        picks: [],
        debug: {
          error: 'failed to parse sportmonks JSON',
          request_date_raw: rawDateStr,
          normalized_date: formatted,
          url: fetchUrl,
          raw: rawText,
        },
        sourceUsed: 'sportmonks',
        total_fetched: 0,
      };
    }

    const fixtures = (data.data || []).slice(0, 10); // cap

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
        date: formatted,
        original_input: rawDateStr,
        normalized_date: formatted,
        sourceUsed: 'sportmonks',
        total_fetched: picks.length,
        raw_source: data,
        request_url: fetchUrl,
      },
    };
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
