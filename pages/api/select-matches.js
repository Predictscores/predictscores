// FILE: pages/api/select-matches.js

import { getTopMatches } from '../../lib/matchSelector';

export default async function handler(req, res) {
  try {
    const dateParam = req.query.date; // optional YYYY-MM-DD
    const result = await getTopMatches(dateParam);
    return res.status(200).json({
      picks: result.picks,
      debug: result.debug,
    });
  } catch (err) {
    console.error('select-matches wrapper error', err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
}
