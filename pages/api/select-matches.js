// FILE: pages/api/select-matches.js

import { fetchApiFootballFixtures } from "../../lib/sources/apiFootball";

export default async function handler(req, res) {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "missing date query param" });
  }

  try {
    // 1) Dohvati sve NS fixture-e za taj datum
    const fixtures = await fetchApiFootballFixtures(date);

    // 2) Mapiraj u picks
    const picks = fixtures.map((m) => {
      const f = m.fixture;
      return {
        fixture_id: f.id,
        league: { id: m.league.id, name: m.league.name },
        teams: {
          home: { id: m.teams.home.id, name: m.teams.home.name },
          away: { id: m.teams.away.id, name: m.teams.away.name },
        },
        datetime_local: {
          status: f.status.short,
          starting_at: {
            date_time: f.date,
            date: f.date.slice(0, 10),
            time: f.date.slice(11, 19),
            timezone: "UTC",
          },
        },
        // TODO: ubaci stvarne model vrednosti ovde
        model_probs: { home: 0.45, draw: 0.25, away: 0.3 },
        predicted: "home",
        btts_probability: 0.4,
        over25_probability: 0.32,
      };
    });

    return res.status(200).json({
      picks,
      debug: { total_fetched: picks.length },
    });
  } catch (err) {
    console.error("/api/select-matches error:", err);
    return res.status(200).json({
      picks: [],
      debug: { error: err.message },
    });
  }
}
