// FILE: lib/matchSelector.js

const SPORTMONKS_BASE = 'https://soccer.sportmonks.com/api/v2.0';
const DEFAULT_LEAGUE_FILTER = null; // možeš dodati filter ako želiš

// Helper: format date to YYYY-MM-DD
function formatDate(d) {
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Simple soft model that gives uniform probabilities and confidence based on placeholder logic.
function deriveSimpleModel(fixture) {
  // uniform 1X2
  const home = 0.4;
  const draw = 0.25;
  const away = 0.35;
  const probs = { home, draw, away };

  // pick highest
  let predicted = 'home';
  if (away > home && away > draw) predicted = 'away';
  else if (draw > home && draw > away) predicted = 'draw';

  // confidence: scaled by spread between best and second best
  const sorted = Object.entries(probs)
    .map(([k, v]) => ({ k, v }))
    .sort((a, b) => b.v - a.v);
  const gap = sorted[0].v - sorted[1].v; // e.g., 0.05
  const confidence = Math.min(100, Math.round((gap / 0.5) * 100)); // arbitrary scaling

  return {
    model_probs: probs,
    predicted,
    confidence,
  };
}

export async function selectMatchesForDate(dateStr) {
  try {
    // use provided date or today in Europe/Belgrade (simple offset)
    const dateToUse = dateStr ? dateStr : formatDate(new Date());
    const formatted = formatDate(dateToUse); // ensure YYYY-MM-DD

    const url = `${SPORTMONKS_BASE}/fixtures/date/${encodeURIComponent(
      formatted
    )}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(
      process.env.SPORTMONKS_KEY || ''
    )}&tz=UTC`;

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      return {
        picks: [],
        debug: {
          error: `sportmonks fetch failed ${res.status}`,
          raw: text,
        },
        sourceUsed: 'sportmonks',
        total_fetched: 0,
      };
    }

    const data = await res.json();
    const fixtures = (data.data || []).slice(0, 10); // limit to first 10

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
        datetime_local: f.time?.starting_at || null,
        model_probs: simple.model_probs,
        predicted: simple.predicted,
        confidence: simple.confidence,
        rankScore: simple.confidence, // placeholder
        // placeholders for more advanced fields:
        btts_probability: null,
        over25_probability: null,
      };
    });

    return {
      picks,
      debug: {
        date: formatted,
        sourceUsed: 'sportmonks',
        total_fetched: picks.length,
      },
    };
  } catch (err) {
    console.error('selectMatchesForDate error:', err);
    return {
      picks: [],
      debug: {
        error: err.message,
      },
      sourceUsed: 'internal-error',
      total_fetched: 0,
    };
  }
}
