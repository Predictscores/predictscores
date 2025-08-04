import getSportMonksFixtures from "@/lib/sources/sportmonks";
import getOdds from "@/lib/sources/theOddsApi";

// (dummy) simple edge calc
function calculateEdge(modelProb, marketProb) {
  if (!modelProb || !marketProb) return 0;
  return modelProb - marketProb;
}

export default async function handler(req, res) {
  try {
    const apiKeySM = process.env.SPORTMONKS_API_KEY;
    const apiKeyOdds = process.env.ODDS_API_KEY;
    const today = new Date().toISOString().slice(0, 10);

    // 1. Povuci mečeve
    const fixtures = await getSportMonksFixtures(today, apiKeySM);

    // 2. Povuci kvote (The Odds API)
    let odds = [];
    try {
      odds = await getOdds("soccer", apiKeyOdds); // sport_key je najčešće "soccer"
    } catch (err) {
      odds = [];
    }

    // Mapiraj Odds API events po home+away team name radi spajanja sa fixtures
    const oddsMap = {};
    odds.forEach(event => {
      const h = (event.home_team || "").toLowerCase();
      const a = (event.away_team || "").toLowerCase();
      oddsMap[`${h}|${a}`] = event;
    });

    // 3. Generiši value bet predloge (samo 1X2 market)
    const valueBets = fixtures.map(fixture => {
      const home = fixture.localTeam?.data?.name?.toLowerCase() || "";
      const away = fixture.visitorTeam?.data?.name?.toLowerCase() || "";
      const oddsEvent = oddsMap[`${home}|${away}`];

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

      if (oddsEvent && oddsEvent.bookmakers?.length > 0) {
        const h2h = oddsEvent.bookmakers[0].markets.find(m => m.key === "h2h");
        if (h2h && h2h.outcomes?.length > 0) {
          const homeOut = h2h.outcomes.find(o => o.name === "Home");
          if (homeOut) {
            pick.type = "MODEL+ODDS";
            pick.market_odds = homeOut.price;
            pick.market_prob = 1 / homeOut.price;
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
    res.status(200).json({ value_bets: [], error: "internal error fallback" });
  }
}
