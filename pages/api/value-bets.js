// FILE: pages/api/value-bets.js

const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!ODDS_API_KEY) {
  console.warn('Missing ODDS_API_KEY in env');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchWithRetry = async (url, options = {}, retries = 2) => {
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
  const total = avgHome + avgDraw + avgAway;
  return {
    home: avgHome / total,
    draw: avgDraw / total,
    away: avgAway / total,
  };
};

const buildSelectMatchesUrl = (req, dateParam) => {
  let origin = '';
  if (process.env.VERCEL_URL) {
    origin = `https://${process.env.VERCEL_URL}`;
  } else if (req.headers['x-forwarded-proto'] && req.headers.host) {
    origin = `${req.headers['x-forwarded-proto']}://${req.headers.host}`;
  } else if (req.headers.host) {
    origin = `https://${req.headers.host}`;
  } else {
    origin = 'http://localhost:3000';
  }
  return `${origin}/api/select-matches${dateParam ? `?date=${dateParam}` : ''}`;
};

const fetchOddsForMatch = async (sportKey, homeName, awayName) => {
  const base = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(
    sportKey
  )}/odds/`;
  const params = new URLSearchParams({
    regions: 'eu',
    markets: 'h2h',
    oddsFormat: 'decimal',
    dateFormat: 'iso',
    apiKey: ODDS_API_KEY,
  });
  const url = `${base}?${params.toString()}`;

  const data = await fetchWithRetry(url);
  if (!Array.isArray(data)) return null;

  const normalizedHome = homeName.toLowerCase();
  const normalizedAway = awayName.toLowerCase();

  const matchEvent = data.find((ev) => {
    const ht = (ev.home_team || '').toLowerCase();
    const at = (ev.away_team || '').toLowerCase();
    const matchA =
      ht.includes(normalizedHome) && at.includes(normalizedAway);
    const matchB =
      ht.includes(normalizedAway) && at.includes(normalizedHome);
    return matchA || matchB;
  });

  if (!matchEvent) return null;

  const books = [];
  if (Array.isArray(matchEvent.bookmakers)) {
    matchEvent.bookmakers.forEach((bm) => {
      const h2hMarket = bm.markets?.find((m) => m.key === 'h2h');
      if (h2hMarket && Array.isArray(h2hMarket.outcomes)) {
        let homeO = null,
          drawO = null,
          awayO = null;
        h2hMarket.outcomes.forEach((o) => {
          const name = (o.name || '').toLowerCase();
          if (name === (matchEvent.home_team || '').toLowerCase()) {
            homeO = o.price;
          } else if (name === (matchEvent.away_team || '').toLowerCase()) {
            awayO = o.price;
          } else if (name === 'draw' || name === 'tie') {
            drawO = o.price;
          }
        });
        if (homeO && drawO && awayO) {
          books.push(removeVig(homeO, drawO, awayO));
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
    const { sport_key } = req.query;
    const dateParam = req.query.date || '';
    const body = req.method === 'POST' ? req.body : {};

    let picks = null;
    let selectUrl = buildSelectMatchesUrl(req, dateParam);
    let selectMatchesRaw = null;

    if (body.picks && Array.isArray(body.picks) && body.picks.length > 0) {
      picks = body.picks;
    } else {
      // fetch select-matches with resilience to non-JSON
      let selRes;
      try {
        selRes = await fetch(selectUrl);
        const contentType = selRes.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const selJson = await selRes.json();
          picks = selJson.picks || [];
          selectMatchesRaw = selJson;
        } else {
          // got HTML or something unexpected
          const text = await selRes.text();
          selectMatchesRaw = { unexpected: text };
          picks = [];
        }
      } catch (e) {
        selectMatchesRaw = { fetch_error: e.message };
        picks = [];
      }
    }

    if (!picks || picks.length === 0) {
      return res.status(400).json({
        error: 'No picks provided or retrieved from select-matches',
        picks: [],
        debug: {
          select_matches_url: selectUrl,
          select_matches_raw: selectMatchesRaw,
        },
      });
    }

    if (!ODDS_API_KEY) {
      return res.status(500).json({ error: 'Missing ODDS_API_KEY in env' });
    }

    const valueCandidates = [];

    for (const pick of picks) {
      const homeName = pick.teams.home.name || '';
      const awayName = pick.teams.away.name || '';
      const sportKey = sport_key || 'soccer';
      const oddsData = await fetchOddsForMatch(
        sportKey,
        homeName,
        awayName
      );
      if (!oddsData || !oddsData.consensus) {
        continue;
      }
      const marketProb = oddsData.consensus;
      const modelProbs = pick.model_probs || {};

      ['home', 'draw', 'away'].forEach((key) => {
        const model_p = modelProbs[key] ?? 0;
        const market_p = marketProb[key] ?? 0;
        const final_prob = (model_p + market_p) / 2;
        const edge = final_prob - market_p;
        if (edge >= 0.05) {
          valueCandidates.push({
            fixture_id: pick.fixture_id,
            league: pick.league,
            teams: pick.teams,
            datetime_local: pick.datetime_local,
            pick: key,
            model_prob: model_p,
            market_prob: market_p,
            edge,
            raw_market: oddsData.raw_event,
            predicted_model: pick.predicted,
            model_confidence: pick.confidence,
          });
        }
      });
    }

    valueCandidates.sort((a, b) => b.edge - a.edge);
    const top = valueCandidates.slice(0, 4);

    return res.status(200).json({
      value_bets: top,
      all_candidates: valueCandidates,
      source_sport_key: sport_key || 'soccer',
      debug: {
        select_matches_url: selectUrl,
      },
    });
  } catch (err) {
    console.error('value-bets error', err);
    res.status(500).json({ error: err.message || 'unknown error' });
  }
}
