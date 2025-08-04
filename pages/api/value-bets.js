// FILE: pages/api/value-bets.js

import { selectMatchesForDate } from '../../lib/matchSelector';

export default async function handler(req, res) {
  try {
    const { sport_key, date, min_edge: me, min_odds: mo } = req.query;
    const minEdge = parseFloat(me ?? '0.05');
    const minOdds = parseFloat(mo ?? '1.3');

    // Step 1: get model picks directly
    const selectResp = await selectMatchesForDate(date);
    const picks = selectResp.picks || [];

    // Normalize candidates
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
        matched_event: null,
        market_prob: null,
        implied_odds: null,
        edge: null,
      };
    });

    // No real market integration yet; fallback top 3 by confidence
    let value_bets = [];
    if (all_candidates.length > 0) {
      value_bets = all_candidates
        .filter((c) => c.model_prob !== null)
        .sort((a, b) => {
          if (b.confidence !== a.confidence) return b.confidence - a.confidence;
          return (b.model_prob || 0) - (a.model_prob || 0);
        })
        .slice(0, 3)
        .map((c) => ({
          ...c,
          edge: null,
          fallback: true,
          reason: 'top model picks (no market data yet)',
        }));
    }

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
