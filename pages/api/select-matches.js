// FILE: pages/api/select-matches.js

import { selectMatchesForDate } from '../../lib/matchSelector';

export default async function handler(req, res) {
  const { date } = req.query;

  try {
    const result = await selectMatchesForDate(date);
    const picks = result.picks || [];

    return res.status(200).json({
      picks,
      debug: result.debug || {},
      sourceUsed: result.debug?.sourceUsed || 'sportmonks',
      total_fetched: result.debug?.total_fetched ?? picks.length,
    });
  } catch (err) {
    console.error('select-matches handler error:', err);
    return res.status(500).json({
      picks: [],
      debug: { error: err.message },
      sourceUsed: 'internal-error',
      total_fetched: 0,
    });
  }
}
