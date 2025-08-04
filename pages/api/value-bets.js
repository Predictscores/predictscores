// FILE: pages/api/value-bets.js

const MIN_ODDS = 1.3; // minimalna tržišna kvota za razmatranje
const MIN_EDGE = 0.05; // minimalni edge
const CACHE_TTL_MS = 3 * 60 * 1000; // keš za 3 minuta

// simple in-memory caches (ephemeral per lambda lifetime)
const selectCache = {
  date: null,
  data: null,
  ts: 0,
};
const oddsCache = new Map(); // key: fixture key, value: { ts, oddsData }

/**
 * Fetch select-matches result, with simple in-memory cache
 */
async function fetchSelectMatches(dateStr, origin) {
  if (selectCache.date === dateStr && Date.now() - selectCache.ts < CACHE_TTL_MS) {
    return selectCache.data;
  }
  const base = origin || `https://predictscores.vercel.app`;
  const url = `${base}/api/select-matches?date=${encodeURIComponent(dateStr)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`select-matches failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  selectCache.date = dateStr;
  selectCache.data = json;
  selectCache.ts = Date.now();
  return json;
}

/**
 * Normalize team name for loose matching
 */
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/\s+/g, '').replace(/[^\w]/g, '');
}

/**
 * Fetch odds for a given fixture from The Odds API.
 * Attempts to match by team names and time.
 */
async function fetchOddsForFixture(pick) {
  // Build a key to cache per unique fixture + date
  const fixtureKey = `${pick.teams.home.name}__${pick.teams.away.name}__${pick.fixture_id}`;

  if (oddsCache.has(fixtureKey)) {
    const entry = oddsCache.get(fixtureKey);
    if (Date.now() - entry.ts < CACHE_TTL_MS) {
      return entry.oddsData;
    }
  }

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error('ODDS_API_KEY missing in environment');
  }

  // Use generic soccer sport; if you know more specific sport_key e.g. "soccer_epl", adapt later.
  // Regions: eu (European), markets: h2h, totals, both teams to score
  const url = new URL(`https://api.the-odds-api.com/v4/sports/soccer/odds/`);
  url.searchParams.set('regions', 'eu');
  url.searchParams.set('markets', 'h2h,totals,bothTeamsToScore');
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');
  url.searchParams.set('apiKey', apiKey);
  // Optionally limit to upcoming only
  url.searchParams.set('daysFrom', '0');
  url.searchParams.set('daysTo', '1');

  let resp;
  try {
    resp = await fetch(url.toString());
  } catch (e) {
    console.warn('Odds API fetch failed', e.message);
    oddsCache.set(fixtureKey, { ts: Date.now(), oddsData: null });
    return null;
  }

  if (!resp.ok) {
    const text = await resp.text();
    console.warn('Odds API non-ok', resp.status, text);
    oddsCache.set(fixtureKey, { ts: Date.now(), oddsData: null });
    return null;
  }

  const events = await resp.json(); // array of events

  // Try to find the matching event by team names (loose)
  const targetHome = normalizeName(pick.teams.home.name);
  const targetAway = normalizeName(pick.teams.away.name);

  let matchedEvent = null;

  for (const ev of events) {
    const evHome = normalizeName(ev.home_team);
    const evAway = normalizeName(ev.away_team);
    // Very loose matching: both names appear in either order
    const homeMatch = evHome.includes(targetHome) || targetHome.includes(evHome);
    const awayMatch = evAway.includes(targetAway) || targetAway.includes(evAway);
    const swapHomeMatch = evHome.includes(targetAway) || targetAway.includes(evHome);
    const swapAwayMatch = evAway.includes(targetHome) || targetHome.includes(evAway);

    if ((homeMatch && awayMatch) || (swapHomeMatch && swapAwayMatch)) {
      matchedEvent = ev;
      break;
    }
  }

  const oddsData = matchedEvent || null;
  oddsCache.set(fixtureKey, { ts: Date.now(), oddsData });
  return oddsData;
}

/**
 * Remove vig per bookmaker for given outcomes.
 * Input: array of bookmakers, each with markets including outcomes with prices.
 * Returns consensus no-vig probabilities for the requested submarket (h2h / totals / btts).
 */
function extractConsensusNoVig(oddsEvent) {
  if (!oddsEvent || !Array.isArray(oddsEvent.bookmakers)) return {};

  // We'll accumulate per market: 1X2 (h2h), Over/Under 2.5, BTTS
  const aggregate = {
    h2h: { home: [], draw: [], away: [] }, // arrays of no-vig probs per bookmaker
    over25: [], // over probability
    btts_yes: [], // BTTS yes probability
  };

  for (const bookmaker of oddsEvent.bookmakers) {
    if (!Array.isArray(bookmaker.markets)) continue;
    for (const market of bookmaker.markets) {
      if (market.key === 'h2h') {
        // expect three outcomes: home team name, Draw, away team name
        const outcomes = market.outcomes || [];
        // build implied
        const implied = {};
        outcomes.forEach((o) => {
          const name = o.name.toLowerCase();
          const price = parseFloat(o.price);
          if (!price || price <= 0) return;
          if (name === 'draw') implied.draw = 1 / price;
          else if (name === (oddsEvent.home_team || '').toLowerCase()) implied.home = 1 / price;
          else if (name === (oddsEvent.away_team || '').toLowerCase()) implied.away = 1 / price;
          else {
            // fallback: try includes (some variations)
            if ((oddsEvent.home_team || '').toLowerCase().includes(name) || name.includes((oddsEvent.home_team || '').toLowerCase())) {
              implied.home = 1 / price;
            } else if ((oddsEvent.away_team || '').toLowerCase().includes(name) || name.includes((oddsEvent.away_team || '').toLowerCase())) {
              implied.away = 1 / price;
            }
          }
        });
        const sumImplied = (implied.home || 0) + (implied.draw || 0) + (implied.away || 0);
        if (sumImplied <= 0) continue;
        // no-vig per bookmaker
        if (implied.home) aggregate.h2h.home.push(implied.home / sumImplied);
        if (implied.draw) aggregate.h2h.draw.push(implied.draw / sumImplied);
        if (implied.away) aggregate.h2h.away.push(implied.away / sumImplied);
      }

      if (market.key === 'totals') {
        // Over/Under typically has two outcomes like "Over 2.5" and "Under 2.5"
        const over = market.outcomes.find((o) => o.name.toLowerCase().startsWith('over'));
        const under = market.outcomes.find((o) => o.name.toLowerCase().startsWith('under'));
        if (!over || !under) continue;
        const overPrice = parseFloat(over.price);
        const underPrice = parseFloat(under.price);
        if (!overPrice || !underPrice) continue;
        const impliedOver = 1 / overPrice;
        const impliedUnder = 1 / underPrice;
        const sum = impliedOver + impliedUnder;
        if (sum <= 0) continue;
        // we want Over 2.5 probability
        aggregate.over25.push(impliedOver / sum);
      }

      // BTTS market: key could vary; try some known possibilities
      if (market.key === 'bothTeamsToScore' || market.key.toLowerCase().includes('btts') || market.key.toLowerCase().includes('both')) {
        const yes = market.outcomes.find((o) => o.name.toLowerCase() === 'yes');
        const no = market.outcomes.find((o) => o.name.toLowerCase() === 'no');
        if (!yes || !no) continue;
        const yesPrice = parseFloat(yes.price);
        const noPrice = parseFloat(no.price);
        if (!yesPrice || !noPrice) continue;
        const impliedYes = 1 / yesPrice;
        const impliedNo = 1 / noPrice;
        const sum = impliedYes + impliedNo;
        if (sum <= 0) continue;
        aggregate.btts_yes.push(impliedYes / sum);
      }
    }
  }

  // average across bookmakers to get consensus no-vig probabilities
  const consensus = {};

  if (aggregate.h2h.home.length) {
    const avgHome = aggregate.h2h.home.reduce((a, b) => a + b, 0) / aggregate.h2h.home.length;
    consensus.home = avgHome;
  }
  if (aggregate.h2h.draw.length) {
    const avgDraw = aggregate.h2h.draw.reduce((a, b) => a + b, 0) / aggregate.h2h.draw.length;
    consensus.draw = avgDraw;
  }
  if (aggregate.h2h.away.length) {
    const avgAway = aggregate.h2h.away.reduce((a, b) => a + b, 0) / aggregate.h2h.away.length;
    consensus.away = avgAway;
  }
  if (aggregate.over25.length) {
    const avgOver = aggregate.over25.reduce((a, b) => a + b, 0) / aggregate.over25.length;
    consensus.over25 = avgOver;
  }
  if (aggregate.btts_yes.length) {
    const avgBtts = aggregate.btts_yes.reduce((a, b) => a + b, 0) / aggregate.btts_yes.length;
    consensus.btts_yes = avgBtts;
  }

  return consensus;
}

/**
 * Compute edge like before: final_prob = (model + market_no_vig)/2; edge = final_prob - market_no_vig
 */
function computeEdge(model_prob, market_no_vig_prob) {
  const final_prob = (model_prob + market_no_vig_prob) / 2;
  return final_prob - market_no_vig_prob;
}

export default async function handler(req, res) {
  try {
    const { sport_key = 'soccer', date } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Get select matches
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const select = await fetchSelectMatches(targetDate, origin);
    const picks = select.picks || [];

    if (!Array.isArray(picks) || picks.length === 0) {
      return res.status(200).json({
        value_bets: [],
        all_candidates: [],
        source_sport_key: sport_key,
        debug: {
          select,
          note: 'no picks to process',
        },
      });
    }

    const candidates = [];

    // For each pick, fetch corresponding odds and produce value bet candidates
    for (const p of picks) {
      const model = p.model_probs || {};
      const confidence = p.confidence ?? 0;
      const oddsEvent = await fetchOddsForFixture(p);
      const consensus = extractConsensusNoVig(oddsEvent);

      // 1X2: model.home/draw/away vs consensus.home/draw/away
      if (model.home != null && model.draw != null && model.away != null) {
        for (const outcome of ['home', 'draw', 'away']) {
          const model_prob = model[outcome];
          const market_no_vig_prob = consensus[outcome];
          if (market_no_vig_prob == null) continue; // no market data
          // convert to consensus odds for filter
          const consensus_odds = market_no_vig_prob > 0 ? 1 / market_no_vig_prob : Infinity;
          if (consensus_odds < MIN_ODDS) continue;
          const edge = computeEdge(model_prob, market_no_vig_prob);
          if (edge < MIN_EDGE) continue;

          const selection = outcome === 'home' ? '1' : outcome === 'draw' ? 'X' : '2';

          candidates.push({
            fixture_id: p.fixture_id,
            type: '1X2',
            selection,
            model_prob: Number(model_prob.toFixed(3)),
            market_prob: Number(market_no_vig_prob.toFixed(3)),
            edge: Number(edge.toFixed(3)),
            market_odds: Number(consensus_odds.toFixed(2)),
            confidence: Number(confidence),
            teams: p.teams,
            league: p.league,
            datetime_local: p.datetime_local,
          });
        }
      }

      // BTTS (Yes)
      if (p.btts_probability != null || consensus.btts_yes != null) {
        const model_prob_yes = p.btts_probability != null ? p.btts_probability : consensus.btts_yes || 0;
        const market_no_vig_prob = consensus.btts_yes;
        if (market_no_vig_prob != null) {
          const consensus_odds = market_no_vig_prob > 0 ? 1 / market_no_vig_prob : Infinity;
          if (consensus_odds >= MIN_ODDS) {
            const edge_yes = computeEdge(model_prob_yes, market_no_vig_prob);
            if (edge_yes >= MIN_EDGE) {
              candidates.push({
                fixture_id: p.fixture_id,
                type: 'BTTS',
                selection: 'Yes',
                model_prob: Number(model_prob_yes.toFixed(3)),
                market_prob: Number(market_no_vig_prob.toFixed(3)),
                edge: Number(edge_yes.toFixed(3)),
                market_odds: Number(consensus_odds.toFixed(2)),
                confidence: Number(confidence),
                teams: p.teams,
                league: p.league,
                datetime_local: p.datetime_local,
              });
            }
          }
        }
      }

      // Over/Under 2.5 -> only Over
      if (p.over25_probability != null || consensus.over25 != null) {
        const model_prob_over = p.over25_probability != null ? p.over25_probability : consensus.over25 || 0;
        const market_no_vig_prob = consensus.over25;
        if (market_no_vig_prob != null) {
          const consensus_odds = market_no_vig_prob > 0 ? 1 / market_no_vig_prob : Infinity;
          if (consensus_odds >= MIN_ODDS) {
            const edge_over = computeEdge(model_prob_over, market_no_vig_prob);
            if (edge_over >= MIN_EDGE) {
              candidates.push({
                fixture_id: p.fixture_id,
                type: 'Over/Under 2.5',
                selection: 'Over',
                model_prob: Number(model_prob_over.toFixed(3)),
                market_prob: Number(market_no_vig_prob.toFixed(3)),
                edge: Number(edge_over.toFixed(3)),
                market_odds: Number(consensus_odds.toFixed(2)),
                confidence: Number(confidence),
                teams: p.teams,
                league: p.league,
                datetime_local: p.datetime_local,
              });
            }
          }
        }
      }
    }

    // sort descending by edge
    candidates.sort((a, b) => b.edge - a.edge);
    const value_bets = candidates.slice(0, 4);

    return res.status(200).json({
      value_bets,
      all_candidates: candidates,
      source_sport_key: sport_key,
      debug: {
        select,
        candidate_count: candidates.length,
        date: targetDate,
      },
    });
  } catch (err) {
    console.error('value-bets error', err);
    return res.status(500).json({
      error: 'internal',
      message: err.message,
    });
  }
}
