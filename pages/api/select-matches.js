// FILE: pages/api/select-matches.js

import { fetchUpcomingFixtures } from '../../lib/sources/sportmonks';

function makeUniqueKey(f) {
  // Za deduplikaciju: league + oba tima + start time
  const leagueId = f.league?.data?.id ?? 'no-league';
  const parts = f.participants?.data?.map(p => p.participant_id).join('-') ?? '';
  const start = f.starting_at || '';
  return `${leagueId}-${parts}-${start}`;
}

export default async function handler(req, res) {
  console.log("▶️ SPORTMONKS_KEY present?", !!process.env.SPORTMONKS_KEY);
  try {
    // 1) Dohvati narednih 10 NS (Not Started) mečeva
    const raw = await fetchUpcomingFixtures(10);
    const fixtures = raw.data || [];

    // 2) Deduplikuj
    const seen = new Set();
    const unique = [];
    for (const f of fixtures) {
      const key = makeUniqueKey(f);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(f);
      }
    }

    // 3) Mapiraj u picks
    const picks = unique.map(f => {
      const parts = f.participants.data;
      const home = parts.find(p => p.meta.location === 'home');
      const away = parts.find(p => p.meta.location === 'away');
      const dt = f.starting_at;
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
            date_time: dt,
            date: dt.slice(0,10),
            time: dt.slice(11,19),
            timezone: 'UTC',
          },
        },
        // TODO: ovde ubaci stvarne vrednosti iz svog modela
        model_probs: { home: 0.45, draw: 0.25, away: 0.3 },
        predicted: 'home',
        btts_probability: 0.4,
        over25_probability: 0.32,
      };
    });

    return res.status(200).json({
      picks,
      debug: { total_fetched: picks.length }
    });
  } catch (err) {
    console.error("/api/select-matches error:", err);
    return res.status(200).json({
      picks: [],
      debug: { error: err.message }
    });
  }
}
