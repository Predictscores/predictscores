// pages/api/value-bets.js
import { fetchSportmonksFixtures } from "../../lib/sources/sportmonks";
import { fetchOdds } from "../../lib/sources/theOddsApi";

// helpers
function normalizeName(name = "") {
  return name.trim().toLowerCase();
}

function impliedProbFromPrice(price) {
  return price > 0 ? 1 / price : 0;
}

function calculateEdge(modelProb, marketProb) {
  return marketProb ? modelProb - marketProb : 0;
}

// reuse retry wrapper like in select-matches if needed
async function fetchSportmonksFixturesWithRetry(date, retries = 3, baseDelay = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetchSportmonksFixtures(date);
    } catch (e) {
      const isServerError =
        e?.message?.includes("500") || e?.message?.includes("503") || e?.message?.toLowerCase().includes("incorrect request");
      if (attempt === retries - 1 || !isServerError) {
        throw e;
      }
      console.warn(`SportMonks fetch attempt ${attempt + 1} failed, retrying...`, e.message);
      await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
    }
  }
  throw new Error("Failed to fetch SportMonks fixtures after retries");
}

export default async function handler(req, res) {
  const {
    sport_key = "soccer",
    date,
    min_edge = 0.05,
    min_odds = 1.3,
  } = req.query;

  console.log("ENV KEYS:", {
    SPORTMONKS_KEY: !!process.env.SPORTMONKS_KEY,
    ODDS_API_KEY: !!process.env.ODDS_API_KEY,
  });

  if (!date) return res.status(400).json({ error: "missing date" });

  try {
    // 1. Get fixtures + placeholder model probs (should eventually come from shared model logic)
    const raw = await fetchSportmonksFixturesWithRetry(date);
    const fixtures = (raw.data || []).filter((f) => f.time?.status === "NS");

    // 2. Get odds (only h2h and totals expected from theOddsApi helper)
    const oddsRaw = await fetchOdds(sport_key);
    const oddsMap = {};
    oddsRaw.forEach((o) => {
      const home = normalizeName(o.home_team);
      const away = normalizeName(o.away_team);
      oddsMap[`${home}|${away}`] = o;
    });

    const value_bets = [];

    for (const f of fixtures) {
      const homeName = normalizeName(f.localTeam.data.name);
      const awayName = normalizeName(f.visitorTeam.data.name);
      const key = `${homeName}|${awayName}`;
      const o = oddsMap[key];

      // Placeholder model probabilities - replace with real model later
      const model_probs = { home: 0.45, draw: 0.25, away: 0.3 };
      const model_over25 = 0.32; // placeholder for Over 2.5
      const model_btts = 0.4; // placeholder for BTTS

      // 1X2 bets: check h2h market
      if (o && Array.isArray(o.bookmakers)) {
        for (const b of o.bookmakers) {
          // H2H
          const h2hMarket = b.markets?.find((m) => m.key === "h2h");
          if (h2hMarket) {
            for (const outcome of h2hMarket.outcomes) {
              const outcomeName = normalizeName(outcome.name);
              let modelProb = 0;
              if (outcomeName === normalizeName(f.localTeam.data.name)) {
                modelProb = model_probs.home;
              } else if (outcomeName === normalizeName(f.visitorTeam.data.name)) {
                modelProb = model_probs.away;
              } else if (outcomeName === "draw") {
                modelProb = model_probs.draw;
              } else {
                continue; // unknown outcome
              }

              if (outcome.price >= Number(min_odds)) {
                const marketProb = impliedProbFromPrice(outcome.price);
                const edge = calculateEdge(modelProb, marketProb);
                if (edge >= Number(min_edge)) {
                  value_bets.push({
                    fixture_id: f.id,
                    market: "1X2",
                    selection: outcomeName,
                    type: "MODEL+ODDS",
                    model_prob: Number(modelProb.toFixed(3)),
                    market_odds: outcome.price,
                    market_prob: Number(marketProb.toFixed(3)),
                    edge: Number(edge.toFixed(3)),
                    confidence: Math.min(100, Math.round(edge * 100)),
                    teams: {
                      home: f.localTeam.data,
                      away: f.visitorTeam.data,
                    },
                    league: f.league.data,
                    datetime_local: f.time,
                    fallback: false,
                    reason: "model+odds",
                  });
                }
              }
            }
          }

          // Over/Under 2.5
          const totalsMarket = b.markets?.find((m) => m.key === "totals");
          if (totalsMarket) {
            // Find Over 2.5 outcome
            const overOutcome = totalsMarket.outcomes.find((oc) =>
              oc.name.toLowerCase().includes("over 2.5")
            );
            if (overOutcome && overOutcome.price >= Number(min_odds)) {
              const marketProb = impliedProbFromPrice(overOutcome.price);
              const edge = calculateEdge(model_over25, marketProb);
              if (edge >= Number(min_edge)) {
                value_bets.push({
                  fixture_id: f.id,
                  market: "Over/Under 2.5",
                  selection: "Over 2.5",
                  type: "MODEL+ODDS",
                  model_prob: Number(model_over25.toFixed(3)),
                  market_odds: overOutcome.price,
                  market_prob: Number(marketProb.toFixed(3)),
                  edge: Number(edge.toFixed(3)),
                  confidence: Math.min(100, Math.round(edge * 100)),
                  teams: {
                    home: f.localTeam.data,
                    away: f.visitorTeam.data,
                  },
                  league: f.league.data,
                  datetime_local: f.time,
                  fallback: false,
                  reason: "model+odds",
                });
              }
            }
          }
        }
      }

      // Fallback / model-only suggestions if nothing passed filters
      // 1X2 fallback: pick top model outcome
      const best1X2 = Object.entries(model_probs).sort((a, b) => b[1] - a[1])[0]; // e.g., ["home", 0.45]
      const selectionMapping = {
        home: f.localTeam.data.name,
        away: f.visitorTeam.data.name,
        draw: "Draw",
      };
      value_bets.push({
        fixture_id: f.id,
        market: "1X2",
        selection: selectionMapping[best1X2[0]],
        type: "MODEL_ONLY",
        model_prob: Number(best1X2[1].toFixed(3)),
        confidence: Math.min(100, Math.round(best1X2[1] * 100)),
        teams: {
          home: f.localTeam.data,
          away: f.visitorTeam.data,
        },
        league: f.league.data,
        datetime_local: f.time,
        fallback: true,
        reason: "model-only",
      });

      // Over/Under 2.5 fallback (model-only over)
      value_bets.push({
        fixture_id: f.id,
        market: "Over/Under 2.5",
        selection: "Over 2.5",
        type: "MODEL_ONLY",
        model_prob: Number(model_over25.toFixed(3)),
        confidence: Math.min(100, Math.round(model_over25 * 100)),
        teams: {
          home: f.localTeam.data,
          away: f.visitorTeam.data,
        },
        league: f.league.data,
        datetime_local: f.time,
        fallback: true,
        reason: "model-only",
      });

      // BTTS fallback (no odds integration here)
      value_bets.push({
        fixture_id: f.id,
        market: "BTTS",
        selection: "Yes",
        type: "MODEL_ONLY",
        model_prob: Number(model_btts.toFixed(3)),
        confidence: Math.min(100, Math.round(model_btts * 100)),
        teams: {
          home: f.localTeam.data,
          away: f.visitorTeam.data,
        },
        league: f.league.data,
        datetime_local: f.time,
        fallback: true,
        reason: "model-only",
      });
    }

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
