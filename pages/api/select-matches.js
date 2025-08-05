// FILE: pages/api/select-matches.js

import { fetchUpcomingFixtures } from '../../lib/sources/sportmonks';

export default async function handler(req, res) {
  try {
    // Dohvati narednih 10 utakmica koje nisu počele
    const raw = await fetchUpcomingFixtures(10);
    const fixtures = raw.data || [];

    // Mapiraj u “picks” format (isti kao do sada)
    const picks = fixtures.map(f => {
      const parts = f.participants.data;
      const home = parts.find(p => p.meta.location === 'home');
      const away = parts.find(p => p.meta.location === 'away');
      return {
        fixture_id: f.id,
        league: { id: f.league.data.id, name: f.league.data.name },
        teams: {
          home: { id: home.participant_id, name: home.name },
          away: { id: away.participant_id, name: away.name },
        },
        datetime_local: {
          status: 'NS',
          starting_at: {
            date_time: f.starting_at,
            date: f.starting_at.slice(0,10),
            time: f.starting_at.slice(11,19),
            timezone: 'UTC',
          },
        },
        model_probs: { home: 0.45, draw: 0.25, away: 0.3 },
        predicted: 'home',
        btts_probability: 0.4,
        over25_probability: 0.32,
      };
    });

    return res.status(200).json({ picks, debug: { total_fetched: picks.length } });
  } catch (err) {
    console.error('🚨 /api/select-matches error:', err);
    return res.status(200).json({ picks: [], debug: { error: err.message } });
  }
}
