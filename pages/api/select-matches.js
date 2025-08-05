// FILE: pages/api/select-matches.js

import { fetchSportmonksFixtures } from '../../lib/sources/sportmonks';

function makeUniqueKey(f) {
  const leagueId = f.league?.data?.id ?? 'no-league';
  const part = (f.participants?.data || []).map(p => p.participant_id).join('-');
  const start = f.starting_at || '';
  return `${leagueId}-${part}-${start}`;
}

export default async function handler(req, res) {
  const { date } = req.query;
  console.log("▶️ SPORTMONKS_KEY present?", !!process.env.SPORTMONKS_KEY);
  if (!date) return res.status(400).json({ error: "missing date query param" });

  try {
    // 1) Fetch
    const raw = await fetchSportmonksFixtures(date);
    const all = raw.data || [];

    // 2) Filter NS (state_id === 1)
    const fixtures = all.filter(f => f.state_id === 1);

    // 3) Deduplicate by league/teams/start
    const seen = new Set();
    const unique = [];
    for (const f of fixtures) {
      const key = makeUniqueKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(f);
    }

    // 4) Map to picks
    const picks = unique.map(f => {
      const parts = f.participants?.data || [];
      const homeP = parts.find(p => p.meta?.location === 'home');
      const awayP = parts.find(p => p.meta?.location === 'away');
      return {
        fixture_id: f.id,
        league: {
          id: f.league.data.id,
          name: f.league.data.name,
        },
        teams: {
          home: homeP
            ? { id: homeP.participant_id, name: homeP.name }
            : { id: null, name: 'Home' },
          away: awayP
            ? { id: awayP.participant_id, name: awayP.name }
            : { id: null, name: 'Away' },
        },
        datetime_local: {
          status: 'NS',
          starting_at: {
            date_time: f.starting_at,
            date: date,
            time: f.starting_at.slice(11),
            timezone: 'UTC',
          },
        },
        // TODO: replace these with your real model outputs
        model_probs: { home: 0.45, draw: 0.25, away: 0.3 },
        predicted: 'home',
        btts_probability: 0.4,
        over25_probability: 0.32,
      };
    });

    res.status(200).json({
      picks,
      debug: { total_fetched: unique.length, raw_count: fixtures.length }
    });
  } catch (err) {
    console.error("/api/select-matches error:", err);
    res.status(200).json({ picks: [], debug: { error: err.message } });
  }
}
