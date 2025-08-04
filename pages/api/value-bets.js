// FILE: pages/api/value-bets.js

/**
 * Simple value-bets endpoint with softened/fallback logic.
 * Query params:
 *   sport_key (ignored for now, kept for compatibility)
 *   date (YYYY-MM-DD) -- forwarded to select-matches
 *   min_edge (default 0.05)
 *   min_odds (default 1.3) -- unused currently since no market data
 */

async function fetchSelectMatches(date) {
  const base =
    process.env.VERCEL_URL && !process.env.VERCEL_URL.startsWith('http')
      ? `https://${process.env.VERCEL_URL}`
      : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

  const url = new URL('/api/select-matches', base);
  if (date) url.searchParams.set('date', date);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`select-matches failed: ${res.status} ${text}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  try {
    const { sport_key, date, min_edge: me, min_odds: mo } = req.query;
    const minEdge = parseFloat(me ?? '0.05');
    const minOdds = parseFloat(mo ?? '1.3');

    // Step 1: get model picks
    const selectResp = await fetchSelectMatches(date);
    const picks = selectResp.picks || [];

    // Build all_candidates in normalized form
    const all_candidates = picks.map((p) => {
      const predicted = p.predicted;
      const model_prob =
        p.model_probs && typeof p.model_probs === 'object' && predicted
          ? p.model_probs[predicted] ?? null
          : null;

      return {
        fixture_id: p.fixture_id,
        league: p.league,
        teams: p.teams,
        datetime_local: p.datetime_local,
        predicted,
        model_probs: p.model_probs,
        model_prob,
        confidence: p.confidence,
        rankScore: p.rankScore,
        // placeholders for market data
        matched_event: p.matched_event || null,
        market_prob: null,
        implied_odds: null,
        edge: null,
      };
    });

    // Step 2: Attempt to compute value bets (market integration is stubbed)
    // Since we have no market data here, value_bets will be empty initially.
    let value_bets = [];

    // (Future) Here you would merge in real market data, compute market_prob/no-vig,
    // implied odds etc., then compute edge = model_prob - market_no_vig_prob
    // And filter: edge >= minEdge && implied_odds >= minOdds.

    // Step 3: Fallback if nothing passes strict filters
    if (value_bets.length === 0) {
      // Take top 3 by confidence (only positive-ish or all if low)
      const fallbackCandidates = all_candidates
        .filter((c) => c.model_prob !== null)
        .sort((a, b) => {
          // prefer higher confidence first, tie-breaker model_prob
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return (b.model_prob || 0) - (a.model_prob || 0);
        })
        .slice(0, 3)
        .map((c) => ({
          ...c,
          edge: null,
          fallback: true,
          reason: 'no strict value bet met, showing top model picks',
        }));
      value_bets = fallbackCandidates;
    }

    // Response
    return res.status(200).json({
      value_bets,
      all_candidates,
      source_sport_key: sport_key || null,
      debug: {
        select: {
          ...selectResp.debug,
          total_picks: picks.length,
        },
        thresholds: {
          min_edge: minEdge,
          min_odds: minOdds,
        },
        fallback_used: true,
      },
    });
  } catch (err) {
    console.error('value-bets error:', err);
    return res.status(500).json({
      error: 'internal error',
      message: err.message,
      value_bets: [],
      all_candidates: [],
    });
  }
}
