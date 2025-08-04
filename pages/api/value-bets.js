import { fetchSportmonksFixtures } from "@/lib/sources/sportmonks";
import { fetchOddsForFixtures } from "@/lib/sources/theOddsApi";
import { calculateEdge } from "@/lib/utils/edge";

// Helper fallback: generiši predloge na osnovu modela ako nema kvota
function modelOnlyPicks(fixtures) {
  return fixtures.map(fixture => ({
    fixture_id: fixture.id,
    type: "MODEL_ONLY",
    selection: "1", // Zamisli da je home favorit
    model_prob: 0.45,
    fallback: true,
    reason: "model-only fallback (no odds data)",
    teams: {
      home: fixture.localTeam.data,
      away: fixture.visitorTeam.data,
    },
    league: fixture.league.data,
    datetime_local: fixture.time,
    confidence: 30,
  }));
}

export default async function handler(req, res) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // 1. Povuci mečeve
    const fixtures = await fetchSportmonksFixtures(today);
    if (!fixtures || fixtures.length === 0) {
      return res.status(200).json({ value_bets: [], reason: "No fixtures today" });
    }

    // 2. Povuci kvote (probaj H2H market samo)
    let oddsMap = {};
    try {
      oddsMap = await fetchOddsForFixtures(
        fixtures.map(f => f.id),
        "h2h" // SAMO 1X2 market!
      );
    } catch (err) {
      console.warn("No odds data or market fetch failed, fallback to model-only.");
      oddsMap = {};
    }

    // 3. Generiši value bet predloge (ako nema kvota, fallback na model)
    const valueBets = fixtures.map(fixture => {
      const pick = {
        fixture_id: fixture.id,
        type: "MODEL_ONLY",
        selection: "1",
        model_prob: 0.45,
        fallback: true,
        reason: "model-only fallback",
        teams: {
          home: fixture.localTeam.data,
          away: fixture.visitorTeam.data,
        },
        league: fixture.league.data,
        datetime_local: fixture.time,
        confidence: 30,
      };

      // Ako postoji H2H kvota, koristi je!
      const oddsEvent = oddsMap[fixture.id];
      if (
        oddsEvent &&
        Array.isArray(oddsEvent.bookmakers) &&
        oddsEvent.bookmakers.length > 0
      ) {
        // Pronađi 1X2 market i home/draw/away kvote
        const h2hMarket = oddsEvent.bookmakers[0].markets?.find(m => m.key === "h2h");
        if (h2hMarket && Array.isArray(h2hMarket.outcomes)) {
          const home = h2hMarket.outcomes.find(o => o.name === "Home");
          if (home) {
            pick.type = "MODEL+ODDS";
            pick.market_odds = home.price;
            pick.market_prob = 1 / home.price;
            pick.edge = calculateEdge(pick.model_prob, pick.market_prob);
            pick.confidence = Math.round(Math.max(0, Math.min(100, pick.edge * 100 / pick.market_prob)));
            pick.fallback = false;
            pick.reason = "model + odds";
          }
        }
      }

      return pick;
    });

    res.status(200).json({ value_bets: valueBets });
  } catch (err) {
    console.error("API ERROR /value-bets:", err);
    res.status(200).json({ value_bets: [], error: "internal error fallback" });
  }
}
