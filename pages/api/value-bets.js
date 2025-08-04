// pages/api/value-bets.js
import getSportMonksFixtures from "../../lib/sources/sportmonks";
import getOdds from "../../lib/sources/theOddsApi";

// simple edge calculation
function calculateEdge(modelProb, marketProb) {
  if (modelProb == null || marketProb == null) return 0;
  return modelProb - marketProb;
}

// normalize team names for matching
function normalizeName(name = "") {
  return name.trim().toLowerCase();
}

export default async function handler(req, res) {
  try {
    const apiKeySM = process.env.SPORTMONKS_API_KEY;
    const apiKeyOdds = process.env.ODDS_API_KEY;
    if (!apiKeySM) {
      return res.status(500).json({ error: "Missing SPORTMONKS_API_KEY" });
    }
    if (!apiKeyOdds) {
      // we can still return model-only picks if odds key missing
      console.warn("ODDS_API_KEY missing, falling back to model-only.");
    }

    const { date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const minEdge = parseFloat(req.query.min_edge) || 0.02;
    const minOdds = parseFloat(req.query.min_odds) || 1.2;

    // 1. Fetch fixtures from SportMonks
    const fixtures = await getSportMonksFixtures(targetDate, apiKeySM);
    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      return res.status(200).json({ value_bets: [], reason: "No fixtures for date" });
    }

    // 2. Fetch odds (H2H only) from The Odds API
    let odds = [];
    if (apiKeyOdds) {
      try {
        odds = await getOdds("soccer", apiKeyOdds); // sport key "soccer" for broad soccer markets
      } catch (e) {
        console.warn("Failed to fetch from Odds API:", e.message);
        odds = [];
      }
    }

    // Build map from odds by normalized home|away
    const oddsMap = {};
    if (Array.isArray(odds)) {
      odds.forEach((event) => {
        const h = normalizeName(event.home_team);
        const a = normalizeName(event.away_team);
        oddsMap[`${h}|${a}`] = event;
      });
    }

    // 3. Generate picks
    const valueBets = fixtures.map((fixture) => {
      // Determine model probabilities (placeholder logic)
      const model_probs = {
        home: 0.45,
        draw: 0.25,
        away: 0.30,
      };
      // Pick best model selection
      const best = Object.entries(model_probs).reduce((prev, curr) =>
        curr[1] > prev[1] ? curr : prev
      ); // [key, prob]
      const selectionMap = {
        home: "1",
        draw: "X",
        away: "2",
      };
      const selection = selectionMap[best[0]] || "1";
      const modelProb = best[1];

      const homeName = fixture.localTeam?.data?.name || "";
      const awayName = fixture.visitorTeam?.data?.name || "";
      const normHome = normalizeName(homeName);
      const normAway = normalizeName(awayName);
      const oddsEvent = oddsMap[`${normHome}|${normAway}`];

      // Base pick (model-only)
      const pick = {
        fixture_id: fixture.id,
        type: "MODEL_ONLY",
        selection,
        model_prob: modelProb,
        fallback: true,
        reason: "model-only fallback",
        teams: {
          home: fixture.localTeam?.data || { name: homeName },
          away: fixture.visitorTeam?.data || { name: awayName },
        },
        league: fixture.league?.data || { name: fixture.league?.data?.name || "?" },
        datetime_local: fixture.time,
        confidence: 30,
      };

      // If odds available, attempt to enhance
      if (
        oddsEvent &&
        Array.isArray(oddsEvent.bookmakers) &&
        oddsEvent.bookmakers.length > 0
      ) {
        const h2hMarket = oddsEvent.bookmakers[0].markets?.find((m) => m.key === "h2h");
        if (h2hMarket && Array.isArray(h2hMarket.outcomes)) {
          // Map outcome names to model selection
          let outcomeToCheck = null;
          if (selection === "1") {
            outcomeToCheck = h2hMarket.outcomes.find((o) => o.name === "Home");
          } else if (selection === "2") {
            outcomeToCheck = h2hMarket.outcomes.find((o) => o.name === "Away");
          } else if (selection === "X") {
            outcomeToCheck = h2hMarket.outcomes.find((o) => o.name === "Draw");
          }

          if (outcomeToCheck && outcomeToCheck.price) {
            const marketOdds = outcomeToCheck.price;
            const marketProb = 1 / marketOdds;
            const edge = calculateEdge(modelProb, marketProb);

            // Apply filters: min edge and min odds
            if (edge >= minEdge && marketOdds >= minOdds) {
              pick.type = "MODEL+ODDS";
              pick.market_odds = marketOdds;
              pick.market_prob = Number(marketProb.toFixed(3));
              pick.edge = Number(edge.toFixed(3));
              pick.confidence = Math.round(
                Math.max(0, Math.min(100, (edge * 100) / marketProb))
              );
              pick.fallback = false;
              pick.reason = "model + odds";
            }
          }
        }
      }

      return pick;
    });

    res.status(200).json({
      value_bets: valueBets,
      debug: {
        date: targetDate,
        thresholds: { min_edge: minEdge, min_odds: minOdds },
        has_odds_api: Boolean(apiKeyOdds),
        fixtures_count: fixtures.length,
      },
    });
  } catch (err) {
    console.error("Value bets handler error:", err);
    res.status(500).json({ value_bets: [], error: err.message || "internal error" });
  }
}
