// FILE: pages/api/value-bets.js

/**
 * Simple value bet selector for soccer:
 * - Takes selects from /api/select-matches
 * - Forms 1X2, BTTS, Over/Under 2.5 candidates
 * - Uses model probabilities provided
 * - Uses placeholder market odds (can be replaced with real Odds API calls)
 * - Computes edge and filters
 */

const MIN_ODDS = 1.3; // minimal market odds to consider
const MIN_EDGE = 0.05; // required edge

// in-memory simple cache to avoid redundant select-matches calls in same execution
let selectCache = {
  date: null,
  data: null,
  ts: 0,
};

async function fetchSelectMatches(dateStr, origin) {
  if (selectCache.date === dateStr && selectCache.data) {
    return selectCache.data;
  }

  // Build URL to own endpoint; prefer using full origin so it works on Vercel
  const base = origin || 'https://predictscores.vercel.app';
  const url = `${base}/api/select-matches?date=${encodeURIComponent(dateStr)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`select-matches failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  selectCache = { date: dateStr, data: json, ts: Date.now() };
  return json;
}

/**
 * Placeholder market odds logic:
 * For now, we simulate a market that is slightly less favorable than model -- so there's potential edge.
 * In practice, replace fetchMarketOdds with real API call to The Odds API and compute no-vig probabilities.
 */
function placeholderMarketFor1X2(model_probs) {
  // model_probs: { home, draw, away } floats summing to ~1
  // Simulate market odds by adding a small margin to implied probabilities (i.e., slightly worse)
  const market = {};
  Object.entries(model_probs).forEach(([key, prob]) => {
    const inflatedProb = Math.min(1, prob + 0.03); // market is slightly more conservative
    const odds = 1 / inflatedProb;
    market[key] = {
      odds: Number(odds.toFixed(2)),
      implied_prob: inflatedProb,
    };
  });
  return market;
}

function placeholderMarketForBTTS(btts_prob) {
  const inflated = Math.min(1, btts_prob + 0.03);
  const odds = 1 / inflated;
  return {
    yes: { odds: Number(odds.toFixed(2)), implied_prob: inflated },
    no: { odds: Number((1 / (1 - Math.min(1, btts_prob - 0.03))).toFixed(2)), implied_prob: 1 - Math.min(1, btts_prob - 0.03) },
  };
}

function placeholderMarketForOver25(over25_prob) {
  const inflated = Math.min(1, over25_prob + 0.03);
  const odds = 1 / inflated;
  return {
    over: { odds: Number(odds.toFixed(2)), implied_prob: inflated },
    under: { odds: Number((1 / (1 - Math.min(1, over25_prob - 0.03))).toFixed(2)), implied_prob: 1 - Math.min(1, over25_prob - 0.03) },
  };
}

function computeEdge(model_prob, market_no_vig_prob) {
  const final_prob = (model_prob + market_no_vig_prob) / 2;
  return final_prob - market_no_vig_prob;
}

export default async function handler(req, res) {
  try {
    const { sport_key = 'soccer', date } = req.query;
    // default to today in Europe/Belgrade if no date
    const targetDate = date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    // fetch select-matches picks
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const select = await fetchSelectMatches(targetDate, origin);
    const picks = select.picks || [];

    if (!Array.isArray(picks) || picks.length === 0) {
      return res.status(200).json({
        value_bets: [],
        all_candidates: [],
        source_sport_key: sport_key,
        debug: {
          select,
        },
      });
    }

    const candidates = [];

    for (const p of picks) {
      // only soccer/football for now
      // skip if no model_probs
      const model = p.model_probs || {};
      const confidence = p.confidence ?? 0;

      // 1X2
      if (model.home != null && model.draw != null && model.away != null) {
        const market = placeholderMarketFor1X2(model);
        // consider each outcome as a possible pick
        for (const outcome of ['home', 'draw', 'away']) {
          const model_prob = model[outcome];
          const market_info = market[outcome];
          if (!market_info) continue;
          const market_odds = market_info.odds;
          if (market_odds < MIN_ODDS) continue;

          // remove nothing fancy: assume implied_prob is already no-vig (since placeholder)
          const market_no_vig_prob = market_info.implied_prob;
          const edge = computeEdge(model_prob, market_no_vig_prob);

          if (edge < MIN_EDGE) continue;

          candidates.push({
            fixture_id: p.fixture_id,
            type: '1X2',
            selection:
              outcome === 'home'
                ? '1'
                : outcome === 'draw'
                ? 'X'
                : '2',
            model_prob: Number(model_prob.toFixed(3)),
            market_prob: Number(market_no_vig_prob.toFixed(3)),
            edge: Number(edge.toFixed(3)),
            market_odds: Number(market_odds.toFixed(2)),
            confidence: Number(confidence),
            teams: p.teams,
            league: p.league,
            datetime_local: p.datetime_local,
          });
        }
      }

      // BTTS (if available)
      if (p.btts_probability != null) {
        const market = placeholderMarketForBTTS(p.btts_probability);
        const model_prob_yes = p.btts_probability;
        const market_info_yes = market.yes;
        if (market_info_yes.odds >= MIN_ODDS) {
          const edge_yes = computeEdge(model_prob_yes, market_info_yes.implied_prob);
          if (edge_yes >= MIN_EDGE) {
            candidates.push({
              fixture_id: p.fixture_id,
              type: 'BTTS',
              selection: 'Yes',
              model_prob: Number(model_prob_yes.toFixed(3)),
              market_prob: Number(market_info_yes.implied_prob.toFixed(3)),
              edge: Number(edge_yes.toFixed(3)),
              market_odds: Number(market_info_yes.odds.toFixed(2)),
              confidence: Number(confidence),
              teams: p.teams,
              league: p.league,
              datetime_local: p.datetime_local,
            });
          }
        }
      }

      // Over/Under 2.5 (if available)
      if (p.over25_probability != null) {
        const market = placeholderMarketForOver25(p.over25_probability);
        const model_prob_over = p.over25_probability;
        const market_info_over = market.over;
        if (market_info_over.odds >= MIN_ODDS) {
          const edge_over = computeEdge(model_prob_over, market_info_over.implied_prob);
          if (edge_over >= MIN_EDGE) {
            candidates.push({
              fixture_id: p.fixture_id,
              type: 'Over/Under 2.5',
              selection: 'Over',
              model_prob: Number(model_prob_over.toFixed(3)),
              market_prob: Number(market_info_over.implied_prob.toFixed(3)),
              edge: Number(edge_over.toFixed(3)),
              market_odds: Number(market_info_over.odds.toFixed(2)),
              confidence: Number(confidence),
              teams: p.teams,
              league: p.league,
              datetime_local: p.datetime_local,
            });
          }
        }
      }
    }

    // sort by edge desc
    candidates.sort((a, b) => b.edge - a.edge);

    // take top 4 value bets
    const value_bets = candidates.slice(0, 4);

    return res.status(200).json({
      value_bets,
      all_candidates: candidates,
      source_sport_key: sport_key,
      debug: {
        select,
        candidate_count: candidates.length,
        date: targetDate,
      },
    });
  } catch (err) {
    console.error('value-bets error', err);
    return res.status(500).json({
      error: 'internal',
      message: err.message,
    });
  }
}
