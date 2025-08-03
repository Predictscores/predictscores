// FILE: pages/api/value-bets.js

// Uses selects from select-matches (model) and The Odds API to compute edge for 1X2 outcomes.
// Expects POST body: { picks: [ ... ] , sport_key: "soccer_brazil" } 
// If picks not provided, requires query param ?date=YYYY-MM-DD and will internally call /api/select-matches to fetch them (best-effort).

const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.warn('Missing ODDS_API_KEY in env');
}

const fetchWithRetry = async (url, options = {}, retries = 2) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      if (retries > 0) {
        await sleep(500);
        return fetchWithRetry(url, options, retries - 1);
      }
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  } catch (e) {
    if (retries > 0) {
      await sleep(500);
      return fetchWithRetry(url, options, retries - 1);
    }
    throw e;
  }
};

// Remove vig for a single bookmaker's 1X2 odds
const removeVig = (h, d, a) => {
  const impliedH = 1 / h;
  const impliedD = 1 / d;
  const impliedA = 1 / a;
  const sum = impliedH + impliedD + impliedA;
  return {
    home: impliedH / sum,
    draw: impliedD / sum,
    away: impliedA / sum,
  };
};

// Average consensus from multiple bookmakers: input array of no-vig probs per book
const consensusNoVig = (books) => {
  if (!books || books.length === 0) return null;
  let sumHome = 0,
    sumDraw = 0,
    sumAway = 0;
  books.forEach((b) => {
    sumHome += b.home;
    sumDraw += b.draw;
    sumAway += b.away;
  });
  const avgHome = sumHome / books.length;
  const avgDraw = sumDraw / books.length;
  const avgAway = sumAway / books.length;
  // renormalize just in case
  const total = avgHome + avgDraw + avgAway;
  return {
    home: avgHome / total,
    draw: avgDraw / total,
    away: avgAway / total,
  };
};

const fetchOddsForMatch = async (sportKey, homeName, awayName, dateISO) => {
  // The Odds API v4 h2h odds for given sport. regions=eu, market=h2h
  // You may adjust region or oddsFormat if needed.
  const base = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(
    sportKey
  )}/odds/`;
  const params = new URLSearchParams({
    regions: 'eu',
    markets: 'h2h',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
    // optionally &bookmakers=... to restrict
    apiKey: ODDS_API_KEY,
  });
  const url = `${base}?${params.toString()}`;

  const data = await fetchWithRetry(url);
  if (!Array.isArray(data)) return null;

  // Match by teams and approximate time: The Odds API returns multiple events; find best match
  // We'll try to find event where home and away names appear (case-insensitive substring)
  const matchEvent = data.find((ev) => {
    const teams = ev.home_team?.toLowerCase() || '';
    const opp = ev.away_team?.toLowerCase() || '';
    const homeLower = homeName.toLowerCase();
    const awayLower = awayName.toLowerCase();
    const nameMatch =
      (teams.includes(homeLower) && opp.includes(awayLower)) ||
      (teams.includes(awayLower) && opp.includes(homeLower)); // tolerate order swap
    // Optionally check start_time proximity if dateISO provided
    return nameMatch;
  });

  if (!matchEvent) return null;

  // Extract h2h odds from all bookmakers for that event
  const books = [];
  if (Array.isArray(matchEvent.bookmakers)) {
    matchEvent.bookmakers.forEach((bm) => {
      const h2hMarket = bm.markets?.find((m) => m.key === 'h2h');
      if (h2hMarket && Array.isArray(h2hMarket.outcomes)) {
        let homeO = null,
          drawO = null,
          awayO = null;
        h2hMarket.outcomes.forEach((o) => {
          if (o.name.toLowerCase() === matchEvent.home_team.toLowerCase()) {
            homeO = o.price;
          } else if (o.name.toLowerCase() === matchEvent.away_team.toLowerCase()) {
            awayO = o.price;
          } else if (
            o.name.toLowerCase() === 'draw' ||
            o.name.toLowerCase() === 'tie'
          ) {
            drawO = o.price;
          }
        });
        // Only include if all three exist
        if (homeO && drawO && awayO) {
          const noVig = removeVig(homeO, drawO, awayO);
          books.push(noVig);
        }
      }
    });
  }

  if (books.length === 0) return null;

  const consensus = consensusNoVig(books);
  return {
    consensus,
    raw_event: matchEvent,
  };
};

export default async function handler(req, res) {
  try {
    let picks = null;
    const { sport_key } = req.query;
    const body = req.method === 'POST' ? await req.json() : {};
    if (body.picks && Array.isArray(body.picks) && body.picks.length > 0) {
      picks = body.picks;
    } else {
      // fallback: call select-matches internally
      const dateParam = req.query.date || '';
      // build URL assuming same origin; if VERCEL_URL exists, prefer that
      const baseHost =
        process.env.VERCEL_URL && !process.env.VERCEL_URL.startsWith('http')
          ? `https://${process.env.VERCEL_URL}`
          : '';
      const selectUrl = `${
        baseHost || ''
      }/api/select-matches${dateParam ? `?date=${dateParam}` : ''}`;
      const selRes = await fetch(selectUrl);
      const selJson = await selRes.json();
      picks = selJson.picks || [];
    }

    if (!picks || picks.length === 0) {
      return res.status(400).json({
        error: 'No picks provided or retrieved from select-matches',
        picks: [],
      });
    }

    if (!ODDS_API_KEY) {
      return res.status(500).json({ error: 'Missing ODDS_API_KEY in env' });
    }

    const valueCandidates = [];

    // For each pick (match), get market consensus and compute edge for each outcome
    for (const pick of picks) {
      const homeName = pick.teams.home.name || '';
      const awayName = pick.teams.away.name || '';
      // sport_key must be provided or guess generic soccer
      const sportKey = sport_key || 'soccer'; // user can pass e.g. soccer_brazil if needed
      const oddsData = await fetchOddsForMatch(
        sportKey,
        homeName,
        awayName,
        null
      );
      if (!oddsData || !oddsData.consensus) {
        continue; // skip if no market data
      }
      const marketProb = oddsData.consensus; // {home, draw, away}
      const modelProbs = pick.model_probs || {};

      // For each outcome compute edge
      ['home', 'draw', 'away'].forEach((key) => {
        const model_p = modelProbs[key] ?? 0;
        const market_p = marketProb[key] ?? 0;
        // final consensus
        const final_prob = (model_p + market_p) / 2;
        const edge = final_prob - market_p;
        // Only positive value bets with decent model confidence (optional threshold)
        if (edge >= 0.05) {
          valueCandidates.push({
            fixture_id: pick.fixture_id,
            league: pick.league,
            teams: pick.teams,
            datetime_local: pick.datetime_local,
            pick: key, // 'home' | 'draw' | 'away'
            model_prob: model_p,
            market_prob: market_p,
            edge,
            odds_implied: {
              // reverse implied from market_prob before removing vig is not available here; we can approximate from consensus
              implied_no_vig: market_p,
            },
            raw_market: oddsData.raw_event,
            predicted_model: pick.predicted,
            model_confidence: pick.confidence,
          });
        }
      });
    }

    // Sort descending edge
    valueCandidates.sort((a, b) => b.edge - a.edge);
    // Top 4
    const top = valueCandidates.slice(0, 4);

    return res.status(200).json({
      value_bets: top,
      all_candidates: valueCandidates,
      source_sport_key: sport_key || 'soccer',
    });
  } catch (err) {
    console.error('value-bets error', err);
    res.status(500).json({ error: err.message || 'unknown error' });
  }
}
