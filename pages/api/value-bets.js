// FILE: pages/api/value-bets.js

import { getTopMatches } from '../../lib/matchSelector';

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

// Normalize team names: remove diacritics, non-alphanumeric, lowercase
const normalizeName = (str) => {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ''); // remove non-alphanumeric
};

// Remove vig for 1X2 (decimal odds)
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

const fetchOddsForSport = async (sportKey) => {
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
  return await fetchWithRetry(url);
};

const findMatchEvent = (events, homeName, awayName) => {
  const normHome = normalizeName(homeName);
  const normAway = normalizeName(awayName);
  return events.find((ev) => {
    const ht = normalizeName(ev.home_team || '');
    const at = normalizeName(ev.away_team || '');

    // exact or substring matching both orders
    const match1 = ht.includes(normHome) && at.includes(normAway);
    const match2 = ht.includes(normAway) && at.includes(normHome);
    return match1 || match2;
  });
};

const extractNoVigFromEvent = (matchEvent) => {
  if (!matchEvent || !Array.isArray(matchEvent.bookmakers)) return null;
  const books = [];
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
  if (books.length === 0) return null;
  return consensusNoVig(books);
};

export default async function handler(req, res) {
  try {
    const { sport_key } = req.query;
    const dateParam = req.query.date || undefined;

    const selectResult = await getTopMatches(dateParam);
    const picks = selectResult.picks || [];

    if (!picks || picks.length === 0) {
      return res.status(400).json({
        error: 'No picks available from model',
        debug: selectResult.debug,
      });
    }

    if (!ODDS_API_KEY) {
      return res.status(500).json({ error: 'Missing ODDS_API_KEY in env' });
    }

    // fetch all market events for transparency/debug
    const rawOdds = await fetchOddsForSport(sport_key || 'soccer');

    const valueCandidates = [];
    const perPickDebug = [];

    for (const pick of picks) {
      const homeName = pick.teams.home.name || '';
      const awayName = pick.teams.away.name || '';
      const sportKey = sport_key || 'soccer';

      // try to locate the event in rawOdds
      const matchEvent = findMatchEvent(
        Array.isArray(rawOdds) ? rawOdds : [],
        homeName,
        awayName
      );

      let marketProb = null;
      let matchInfo = null;
      if (matchEvent) {
        marketProb = extractNoVigFromEvent(matchEvent);
        matchInfo = matchEvent;
      }

      const modelProbs = pick.model_probs || {};

      // compute edges if market data exists
      if (marketProb) {
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
              raw_market: matchEvent,
              predicted_model: pick.predicted,
              model_confidence: pick.confidence,
            });
          }
        });
      }

      perPickDebug.push({
        fixture_id: pick.fixture_id,
        teams: pick.teams,
        predicted: pick.predicted,
        model_probs: modelProbs,
        confidence: pick.confidence,
        matched_event: matchEvent ? { home_team: matchEvent.home_team, away_team: matchEvent.away_team, id: matchEvent.id } : null,
        market_prob: marketProb,
      });
    }

    valueCandidates.sort((a, b) => b.edge - a.edge);
    const top = valueCandidates.slice(0, 4);

    return res.status(200).json({
      value_bets: top,
      all_candidates: valueCandidates,
      source_sport_key: sport_key || 'soccer',
      debug: {
        select: selectResult.debug,
        raw_odds_events_sample: Array.isArray(rawOdds)
          ? rawOdds.slice(0, 5).map((ev) => ({
              home_team: ev.home_team,
              away_team: ev.away_team,
              sport_key: ev.sport_key,
              commence_time: ev.commence_time,
              bookmakers_count: ev.bookmakers?.length || 0,
            }))
          : rawOdds,
        per_pick: perPickDebug,
      },
    });
  } catch (err) {
    console.error('value-bets error', err);
    res.status(500).json({ error: err.message || 'unknown error' });
  }
}
