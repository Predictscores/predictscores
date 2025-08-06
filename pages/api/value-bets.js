// FILE: pages/api/value-bets.js

import { fetchApiFootballFixtures } from '../../lib/sources/apiFootball';

function calculateEdge(modelProb, marketProb) {
  return marketProb ? modelProb - marketProb : 0;
}

export default async function handler(req, res) {
  const { date, min_edge = 0.05, min_odds = 1.3 } = req.query;
  if (!date) return res.status(400).json({ error: "missing date" });

  try {
    // 1) Dohvati NS mečeve iz API-Football
    const raw = await fetchApiFootballFixtures(date);
    // raw je niz objekata { fixture, league, teams, ... }

    // 2) Napravi mapu kvota (bookmakers → h2h)
    // Ovde pretpostavljamo da raw[i].odds postoji, ili
    // možeš da dropuješ kvote ako nemaš API za kvote
    const value_bets = raw.map(m => {
      const f = m.fixture;
      const home = m.teams.home;
      const away = m.teams.away;
      const base = {
        fixture_id: f.id,
        market: "1X2",
        selection: home.name.toLowerCase(),
        type: "MODEL_ONLY",
        model_prob: 0.45,
        teams: { home, away },
        datetime_local: {
          status: f.status.short,
          starting_at: {
            date_time: f.date,
            date: f.date.slice(0,10),
            time: f.date.slice(11,19),
            timezone: 'UTC'
          }
        },
        fallback: true,
        reason: "model-only",
      };

      // Ako imaš kvote u m.odds, izračunaj edge:
      // const oddsData = m.odds….find(b => b.bookmaker === 'some');
      // ... ista logika kao pre, samo prilagodi strukturu…

      return base;
    });

    return res.status(200).json({
      value_bets,
      all_candidates: value_bets,
      debug: { total_fetched: raw.length }
    });
  } catch (err) {
    console.error("/api/value-bets error:", err);
    return res.status(200).json({ value_bets: [], debug: { error: err.message } });
  }
}
