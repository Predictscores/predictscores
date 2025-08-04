import { NextResponse } from 'next/server';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date') || new Date().toISOString().split('T')[0];
  const minEdge = parseFloat(searchParams.get('min_edge')) || 0.02;
  const minOdds = parseFloat(searchParams.get('min_odds')) || 1.2;

  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  const SPORTMONKS_API_KEY = process.env.SPORTMONKS_API_KEY;

  const oddsUrl = new URL('https://api.the-odds-api.com/v4/sports/soccer_epl/odds');
  oddsUrl.searchParams.set('apiKey', ODDS_API_KEY);
  oddsUrl.searchParams.set('regions', 'eu');
  oddsUrl.searchParams.set('markets', 'h2h,totals,btts'); // ✅ fixed from 'bothteamscore' to 'btts'
  oddsUrl.searchParams.set('dateFormat', 'iso');

  const sportmonksUrl = `https://soccer.sportmonks.com/api/v2.0/fixtures/date/${date}?include=localTeam,visitorTeam,league&api_token=${SPORTMONKS_API_KEY}&tz=UTC`;

  try {
    const [sportmonksRes, oddsRes] = await Promise.all([
      fetch(sportmonksUrl),
      fetch(oddsUrl)
    ]);

    const sportmonksData = await sportmonksRes.json();
    const oddsData = await oddsRes.json();

    if (!Array.isArray(oddsData)) {
      return NextResponse.json({
        value_bets: [],
        debug: { error: 'Invalid odds data', raw_odds_fetch: oddsData }
      });
    }

    const valueBets = [];

    for (const fixture of sportmonksData?.data || []) {
      const homeTeam = fixture.localTeam.data.name;
      const awayTeam = fixture.visitorTeam.data.name;
      const fixtureTime = fixture.time.starting_at.date_time;

      const matchingOdds = oddsData.find(odds => {
        return odds.home_team === homeTeam && odds.away_team === awayTeam;
      });

      const modelProbs = {
        home: 0.45,
        draw: 0.25,
        away: 0.30,
      };

      if (matchingOdds) {
        for (const market of matchingOdds.bookmakers?.[0]?.markets || []) {
          if (market.key === 'h2h') {
            const outcomes = market.outcomes;
            for (const outcome of outcomes) {
              const selection = outcome.name.toLowerCase();
              const modelProb =
                selection === homeTeam.toLowerCase()
                  ? modelProbs.home
                  : selection === awayTeam.toLowerCase()
                    ? modelProbs.away
                    : modelProbs.draw;

              const edge = modelProb - (1 / outcome.price);
              if (edge >= minEdge && outcome.price >= minOdds) {
                valueBets.push({
                  fixture_id: fixture.id,
                  selection: outcome.name,
                  model_prob: modelProb,
                  market_prob: (1 / outcome.price).toFixed(3),
                  market_odds: outcome.price,
                  edge: edge.toFixed(3),
                  confidence: Math.round(modelProb * 100),
                  teams: {
                    home: { name: homeTeam },
                    away: { name: awayTeam }
                  },
                  league: { name: fixture.league.data.name },
                  datetime_local: fixture.time,
                });
              }
            }
          }

          if (market.key === 'btts') {
            const yes = market.outcomes.find((o) => o.name.toLowerCase() === 'yes');
            const no = market.outcomes.find((o) => o.name.toLowerCase() === 'no');

            if (yes && yes.price >= minOdds) {
              const modelProb = 0.52;
              const edge = modelProb - (1 / yes.price);
              if (edge >= minEdge) {
                valueBets.push({
                  fixture_id: fixture.id,
                  selection: 'BTTS: Yes',
                  model_prob: modelProb,
                  market_prob: (1 / yes.price).toFixed(3),
                  market_odds: yes.price,
                  edge: edge.toFixed(3),
                  confidence: Math.round(modelProb * 100),
                  teams: {
                    home: { name: homeTeam },
                    away: { name: awayTeam }
                  },
                  league: { name: fixture.league.data.name },
                  datetime_local: fixture.time,
                });
              }
            }
          }
        }
      } else {
        valueBets.push({
          fixture_id: fixture.id,
          type: 'MODEL_ONLY',
          selection: '1',
          model_prob: modelProbs.home,
          fallback: true,
          reason: 'model-only fallback',
          confidence: Math.round(modelProbs.home * 100),
          teams: {
            home: { name: homeTeam },
            away: { name: awayTeam }
          },
          league: { name: fixture.league.data.name },
          datetime_local: fixture.time,
        });
      }
    }

    return NextResponse.json({ value_bets: valueBets, source: 'sportmonks + odds', total: valueBets.length });
  } catch (err) {
    return NextResponse.json({
      value_bets: [],
      error: err.message || 'Unknown error occurred',
    });
  }
}
