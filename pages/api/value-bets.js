import { fetchSportmonksFixtures } from "@/lib/sources/sportmonks";
import { fetchOddsForFixtures } from "@/lib/sources/theOddsApi";
import { calculateEdge } from "@/lib/utils/edge";

export default async function handler(req, res) {
  const today = new Date().toISOString().slice(0, 10); // format YYYY-MM-DD

  try {
    const fixtures = await fetchSportmonksFixtures(today);
    const oddsMap = await fetchOddsForFixtures(fixtures.map((f) => f.id));

    const valueBets = fixtures.map((fixture) => {
      const model_probs = {
        home: 0.45,
        draw: 0.25,
        away: 0.3,
      };

      const selection = Object.entries(model_probs).reduce((a, b) =>
        b[1] > a[1] ? b : a
      )[0];

      const pick = {
        fixture_id: fixture.id,
        type: "MODEL_ONLY",
        selection: selection === "home" ? "1" : selection === "draw" ? "X" : "2",
        model_prob: model_probs[selection],
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

      const matchingOdds = oddsMap[fixture.id];
      if (
        matchingOdds &&
        Array.isArray(matchingOdds.bookmakers) &&
        matchingOdds.bookmakers.length > 0 &&
        Array.isArray(matchingOdds.bookmakers[0].markets)
      ) {
        for (const market of matchingOdds.bookmakers[0].markets) {
          const outcome = market.outcomes?.find(
            (o) =>
              (o.name === "Home" && pick.selection === "1") ||
              (o.name === "Draw" && pick.selection === "X") ||
              (o.name === "Away" && pick.selection === "2")
          );

          if (outcome && outcome.price) {
            pick.market_odds = outcome.price;
            const implied = 1 / outcome.price;
            pick.market_prob = implied;
            pick.edge = calculateEdge(pick.model_prob, implied);
            pick.confidence = Math.round(
              Math.max(0, Math.min(100, pick.edge * 100 / implied))
            );
            pick.fallback = false;
            pick.reason = "model + odds match";
          }
        }
      }

      return pick;
    });

    res.status(200).json({ value_bets: valueBets });
  } catch (err) {
    console.error("API ERROR /value-bets:", err);
    res.status(500).json({ error: "Failed to fetch value bets" });
  }
}
