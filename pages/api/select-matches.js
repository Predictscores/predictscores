// FILE: pages/api/select-matches.js

import { fetchSportmonksFixtures } from '../../lib/sources/sportmonks';

async function fetchFootballDataFixtures(date) {
  const apiKey = process.env.FOOTBALL_DATA_KEY;
  if (!apiKey) throw new Error("Missing FOOTBALL_DATA_KEY env var");

  const url = `https://api.football-data.org/v4/matches?dateFrom=${encodeURIComponent(date)}&dateTo=${encodeURIComponent(date)}`;
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': apiKey }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Football-Data fetch failed ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  return Array.isArray(json.matches) ? json.matches : [];
}

function makeUniqueKey(f) {
  // For SportMonks: participants; for Football-Data: homeId-awayId
  if (f.participants) {
    const leagueId = f.league?.data?.id ?? 'no-league';
    const partIds = (f.participants.data || []).map(p => p.participant_id).join('-');
    return `${leagueId}-${partIds}-${f.starting_at || ''}`;
  } else {
    // Football-Data match
    return `${f.id}`;
  }
}

export default async function handler(req, res) {
  const { date } = req.query;
  console.log("▶️ Keys:", {
    SPORTMONKS: !!process.env.SPORTMONKS_KEY,
    FOOTBALL_DATA: !!process.env.FOOTBALL_DATA_KEY
  });
  if (!date) return res.status(400).json({ error: "missing date" });

  try {
    // 1) Try SportMonks
    let raw = await fetchSportmonksFixtures(date);
    let fixtures = (raw.data || []).filter(f => f.state_id === 1);

    // 2) Fallback to Football-Data.org if no SportMonks fixtures
    if (fixtures.length === 0) {
      const fd = await fetchFootballDataFixtures(date);
      fixtures = fd.filter(m => m.status === 'SCHEDULED').map(m => ({
        // Normalize to same shape as SportMonks partial
        ...m,
        participants: {
          data: [
            { participant_id: m.homeTeam.id, name: m.homeTeam.name, meta: { location: 'home' } },
            { participant_id: m.awayTeam.id, name: m.awayTeam.name, meta: { location: 'away' } }
          ]
        },
        league: { data: { id: m.competition.id, name: m.competition.name } },
        starting_at: m.utcDate,
        state_id: 1
      }));
    }

    // 3) Dedupe
    const seen = new Set();
    const unique = [];
    for (const f of fixtures) {
      const key = makeUniqueKey(f);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(f);
      }
    }

    // 4) Map into picks
    const picks = unique.map(f => {
      const parts = f.participants.data || [];
      const homeP = parts.find(p => p.meta.location === 'home');
      const awayP = parts.find(p => p.meta.location === 'away');
      const dt = f.starting_at || f.utcDate;
      return {
        fixture_id: f.id,
        league: { id: f.league.data.id, name: f.league.data.name },
        teams: {
          home: homeP ? { id: homeP.participant_id, name: homeP.name } : { id: null, name: 'Home' },
          away: awayP ? { id: awayP.participant_id, name: awayP.name } : { id: null, name: 'Away' }
        },
        datetime_local: {
          status: 'NS',
          starting_at: {
            date_time: dt,
            date: dt.slice(0, 10),
            time: dt.slice(11, 19),
            timezone: 'UTC'
          }
        },
        // TODO: replace with real model outputs
        model_probs: { home: 0.45, draw: 0.25, away: 0.3 },
        predicted: 'home',
        btts_probability: 0.4,
        over25_probability: 0.32
      };
    });

    return res.status(200).json({
      picks,
      debug: { total_fetched: unique.length, raw_count: fixtures.length }
    });
  } catch (err) {
    console.error("🚨 /api/select-matches error:", err);
    return res.status(200).json({ picks: [], debug: { error: err.message } });
  }
}
