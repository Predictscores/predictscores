import { fetchSportmonksFixtures } from "@/lib/sources/sportmonks";
import { fetchOdds } from "@/lib/sources/theOddsApi";

function calculateEdge(modelProb, marketProb) {
  return marketProb ? modelProb - marketProb : 0;
}

export default async function handler(req, res) {
  const { sport_key = "soccer", date, min_edge = 0.05, min_odds = 1.3 } = req.query;
  if (!date) return res.status(400).json({ error: "missing date" });

  try {
    // 1) Fixtures
    const raw = await fetchSportmonksFixtures(date);
    const fixtures = (raw.data || []).filter(f => f.time?.status === "NS");

    // 2) Odds
    const oddsRaw = await fetchOdds(sport_key);
    const oddsMap = {};
    oddsRaw.forEach(o => {
      const h = o.home_team.toLowerCase();
      const a = o.away_team.toLowerCase();
      oddsMap[`${h}|${a}`] = o;
    });

    // 3) Build value bets
    const value_bets = fixtures.map(f => {
      const home = f.localTeam.data.name.toLowerCase();
      const away = f.visitorTeam.data.name.toLowerCase();
      const base = {
        fixture_id: f.id,
        type: "MODEL_ONLY",
        selection: "1",
        model_prob: 0.45,
        confidence: 30,
        teams: {
          home: f.localTeam.data,
          away: f.visitorTeam.data,
        },
        league: f.league.data,
        datetime_local: f.time,
        fallback: true,
        reason: "model-only",
      };

      const o = oddsMap[`${home}|${away}`];
      if (o && Array.isArray(o.bookmakers)) {
        let mkt = null;
        for (const b of o.bookmakers) {
          mkt = b.markets?.find(m => m.key === "h2h");
          if (mkt) break;
        }
        if (mkt) {
          const outcome = mkt.outcomes.find(o => o.name.toLowerCase() === f.localTeam.data.name.toLowerCase());
          if (outcome && outcome.price >= Number(min_odds)) {
            const mp = 1 / outcome.price;
            const edge = calculateEdge(base.model_prob, mp);
            if (edge >= Number(min_edge)) {
              base.type = "MODEL+ODDS";
              base.market_odds = outcome.price;
              base.market_prob = Number(mp.toFixed(3));
              base.edge = Number(edge.toFixed(3));
              base.confidence = Math.min(100, Math.round(edge * 100));
              base.fallback = false;
              base.reason = "model+odds";
            }
          }
        }
      }

      return base;
    });

    res.status(200).json({
      value_bets,
      all_candidates: value_bets,
      debug: { total_fetched: fixtures.length },
    });
  } catch (err) {
    console.error("/api/value-bets error:", err);
    res.status(200).json({ value_bets: [], debug: { error: err.message } });
  }
}
