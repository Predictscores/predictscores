// FILE: pages/api/value-bets.js

import { selectMatchesForDate } from '../../lib/matchSelector';

/* Utility: Levenshtein distance for fuzzy string similarity */
function levenshtein(a = '', b = '') {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) =>
    Array.from({ length: a.length + 1 }, (_, j) => 0)
  );
  for (let i = 0; i <= b.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1].toLowerCase() === b[i - 1].toLowerCase() ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[b.length][a.length];
}

function similarity(a = '', b = '') {
  if (!a || !b) return 0;
  const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen; // normalized [0,1]
}

function normalizeName(name = '') {
  return name.toLowerCase().replace(/[\W_]+/g, '');
}

function computeEdge(model_prob, market_no_vig_prob) {
  return model_prob - market_no_vig_prob;
}

/* Consensus extraction same as before */
function extractConsensusNoVig(oddsEvent) {
  if (!oddsEvent || !Array.isArray(oddsEvent.bookmakers)) return {};
  const aggregate = {
    h2h: { home: [], draw: [], away: [] },
    over25: [],
    btts_yes: [],
  };

  for (const bookmaker of oddsEvent.bookmakers) {
    if (!Array.isArray(bookmaker.markets)) continue;
    for (const market of bookmaker.markets) {
      if (market.key === 'h2h') {
        const outcomes = market.outcomes || [];
        const implied = {};
        outcomes.forEach((o) => {
          const name = o.name.toLowerCase();
          const price = parseFloat(o.price);
          if (!price || price <= 0) return;
          if (name === 'draw') implied.draw = 1 / price;
          else if (name === (oddsEvent.home_team || '').toLowerCase()) implied.home = 1 / price;
          else if (name === (oddsEvent.away_team || '').toLowerCase()) implied.away = 1 / price;
          else {
            if ((oddsEvent.home_team || '').toLowerCase().includes(name) || name.includes((oddsEvent.home_team || '').toLowerCase())) {
              implied.home = 1 / price;
            } else if ((oddsEvent.away_team || '').toLowerCase().includes(name) || name.includes((oddsEvent.away_team || '').toLowerCase())) {
              implied.away = 1 / price;
            }
          }
        });
        const sumImplied = (implied.home || 0) + (implied.draw || 0) + (implied.away || 0);
        if (sumImplied <= 0) continue;
        if (implied.home) aggregate.h2h.home.push(implied.home / sumImplied);
        if (implied.draw) aggregate.h2h.draw.push(implied.draw / sumImplied);
        if (implied.away) aggregate.h2h.away.push(implied.away / sumImplied);
      }

      if (market.key === 'totals') {
        const over = market.outcomes.find((o) => o.name.toLowerCase().startsWith('over 2.5'));
        const under = market.outcomes.find((o) => o.name.toLowerCase().startsWith('under 2.5'));
        if (!over || !under) continue;
        const overPrice = parseFloat(over.price);
        const underPrice = parseFloat(under.price);
        if (!overPrice || !underPrice) continue;
        const impliedOver = 1 / overPrice;
        const impliedUnder = 1 / underPrice;
        const sum = impliedOver + impliedUnder;
        if (sum <= 0) continue;
        aggregate.over25.push(impliedOver / sum);
      }

      if (
        market.key === 'bothTeamsToScore' ||
        market.key.toLowerCase().includes('btts') ||
        market.key.toLowerCase().includes('both')
      ) {
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

  const consensus = {};
  if (aggregate.h2h.home.length) consensus.home = aggregate.h2h.home.reduce((a, b) => a + b, 0) / aggregate.h2h.home.length;
  if (aggregate.h2h.draw.length) consensus.draw = aggregate.h2h.draw.reduce((a, b) => a + b, 0) / aggregate.h2h.draw.length;
  if (aggregate.h2h.away.length) consensus.away = aggregate.h2h.away.reduce((a, b) => a + b, 0) / aggregate.h2h.away.length;
  if (aggregate.over25.length) consensus.over25 = aggregate.over25.reduce((a, b) => a + b, 0) / aggregate.over25.length;
  if (aggregate.btts_yes.length) consensus.btts_yes = aggregate.btts_yes.reduce((a, b) => a + b, 0) / aggregate.btts_yes.length;

  return consensus;
}

/* Fetch all relevant odds events once per request */
let cachedOddsEvents = null;
async function fetchAllOddsEvents() {
  if (cachedOddsEvents) return cachedOddsEvents;
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];
  const url = new URL('https://api.the-odds-api.com/v4/sports/soccer/odds/');
  url.searchParams.set('regions', 'eu');
  url.searchParams.set('markets', 'h2h,totals,bothTeamsToScore');
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('daysFrom', '0');
  url.searchParams.set('daysTo', '1');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const events = await res.json();
    cachedOddsEvents = Array.isArray(events) ? events : [];
    return cachedOddsEvents;
  } catch (e) {
    return [];
  }
}

/* Best-match logic with fuzzy similarity */
function findBestMatchEvent(pick, events) {
  const targetHome = normalizeName(pick.teams.home.name);
  const targetAway = normalizeName(pick.teams.away.name);

  let best = null;
  let bestScore = 0;

  for (const ev of events) {
    const evHome = normalizeName(ev.home_team || '');
    const evAway = normalizeName(ev.away_team || '');

    // similarity per side
    const homeSim = similarity(evHome, targetHome);
    const awaySim = similarity(evAway, targetAway);
    const reversedHomeSim = similarity(evHome, targetAway);
    const reversedAwaySim = similarity(evAway, targetHome);

    // two possibilities: direct or swapped (home/away)
    const directScore = (homeSim + awaySim) / 2;
    const swappedScore = (reversedHomeSim + reversedAwaySim) / 2;

    const candidateScore = Math.max(directScore, swappedScore);

    if (candidateScore > bestScore) {
      bestScore = candidateScore;
      best = { event: ev, score: candidateScore, direct: directScore >= swappedScore };
    }
  }

  return best ? best : null;
}

export default async function handler(req, res) {
  try {
    const { sport_key = 'soccer', date, min_edge: me, min_odds: mo } = req.query;
    const minEdge = parseFloat(me ?? '0.03');
    const minOdds = parseFloat(mo ?? '1.2');

    const selectResp = await selectMatchesForDate(date);
    const picks = selectResp.picks || [];

    if (!Array.isArray(picks) || picks.length === 0) {
      return res.status(200).json({
        value_bets: [],
        all_candidates: [],
        source_sport_key: sport_key,
        debug: {
          select: selectResp.debug,
          note: 'no picks available',
        },
      });
    }

    const allOddsEvents = await fetchAllOddsEvents();
    const rawSample = allOddsEvents.slice(0, 5).map((ev) => ({
      home_team: ev.home_team,
      away_team: ev.away_team,
      commence_time: ev.commence_time,
      bookmakers_count: Array.isArray(ev.bookmakers) ? ev.bookmakers.length : 0,
    }));

    const candidates = [];
    const perPickDebug = [];

    for (const p of picks) {
      const model = p.model_probs || {};
      const confidence = p.confidence ?? 0;
      const predicted = p.predicted;
      const model_prob = predicted && model[predicted] != null ? model[predicted] : null;

      const pickDebug = {
        fixture_id: p.fixture_id,
        teams: p.teams,
        model_probs: model,
        predicted,
        consensus: {},
        matched_odds_event: null,
        edges: [],
        best_match_score: null,
        best_match_names: null,
      };

      // find best fuzzy match
      let matchedOddsEvent = null;
      let matchInfo = null;
      if (allOddsEvents.length > 0) {
        const best = findBestMatchEvent(p, allOddsEvents);
        if (best && best.score >= 0.6) {
          matchedOddsEvent = best.event;
          pickDebug.best_match_score = Number(best.score.toFixed(3));
          pickDebug.best_match_names = {
            home: best.event.home_team,
            away: best.event.away_team,
            direct: best.direct,
          };
          pickDebug.matched_odds_event = {
            home_team: matchedOddsEvent.home_team,
            away_team: matchedOddsEvent.away_team,
            commence_time: matchedOddsEvent.commence_time,
            bookmakers_count: Array.isArray(matchedOddsEvent.bookmakers) ? matchedOddsEvent.bookmakers.length : 0,
          };
        } else if (best) {
          // keep best score for visibility, but no match if below threshold
          pickDebug.best_match_score = Number(best.score.toFixed(3));
          pickDebug.best_match_names = {
            home: best.event.home_team,
            away: best.event.away_team,
            direct: best.direct,
          };
        }
      }

      const consensus = extractConsensusNoVig(matchedOddsEvent);
      pickDebug.consensus = consensus;

      // 1X2
      if (model.home != null && model.draw != null && model.away != null) {
        for (const outcome of ['home', 'draw', 'away']) {
          const mprob = model[outcome];
          const market_no_vig_prob = consensus[outcome];
          if (market_no_vig_prob == null) continue;
          const edge = computeEdge(mprob, market_no_vig_prob);
          const implied_odds = market_no_vig_prob > 0 ? 1 / market_no_vig_prob : null;
          pickDebug.edges.push({
            market: '1X2',
            outcome,
            model_prob: Number(mprob.toFixed(3)),
            market_prob: Number(market_no_vig_prob.toFixed(3)),
            edge: Number(edge.toFixed(3)),
            implied_odds: implied_odds ? Number(implied_odds.toFixed(2)) : null,
          });
          if (implied_odds && implied_odds >= minOdds && edge >= minEdge) {
            const selection = outcome === 'home' ? '1' : outcome === 'draw' ? 'X' : '2';
            candidates.push({
              fixture_id: p.fixture_id,
              type: '1X2',
              selection,
              model_prob: Number(mprob.toFixed(3)),
              market_prob: Number(market_no_vig_prob.toFixed(3)),
              edge: Number(edge.toFixed(3)),
              market_odds: Number(implied_odds.toFixed(2)),
              confidence: Number(confidence),
              teams: p.teams,
              league: p.league,
              datetime_local: p.datetime_local,
            });
          }
        }
      }

      // BTTS
      if ((p.btts_probability != null || consensus.btts_yes != null)) {
        const model_prob_yes = p.btts_probability != null ? p.btts_probability : consensus.btts_yes || 0;
        const market_no_vig_prob = consensus.btts_yes;
        if (market_no_vig_prob != null) {
          const edge_yes = computeEdge(model_prob_yes, market_no_vig_prob);
          const implied_odds = market_no_vig_prob > 0 ? 1 / market_no_vig_prob : null;
          pickDebug.edges.push({
            market: 'BTTS',
            outcome: 'Yes',
            model_prob: Number(model_prob_yes.toFixed(3)),
            market_prob: Number(market_no_vig_prob.toFixed(3)),
            edge: Number(edge_yes.toFixed(3)),
            implied_odds: implied_odds ? Number(implied_odds.toFixed(2)) : null,
          });
          if (implied_odds && implied_odds >= minOdds && edge_yes >= minEdge) {
            candidates.push({
              fixture_id: p.fixture_id,
              type: 'BTTS',
              selection: 'Yes',
              model_prob: Number(model_prob_yes.toFixed(3)),
              market_prob: Number(market_no_vig_prob.toFixed(3)),
              edge: Number(edge_yes.toFixed(3)),
              market_odds: Number(implied_odds.toFixed(2)),
              confidence: Number(confidence),
              teams: p.teams,
              league: p.league,
              datetime_local: p.datetime_local,
            });
          }
        }
      }

      // Over/Under 2.5
      if ((p.over25_probability != null || consensus.over25 != null)) {
        const model_prob_over = p.over25_probability != null ? p.over25_probability : consensus.over25 || 0;
        const market_no_vig_prob = consensus.over25;
        if (market_no_vig_prob != null) {
          const edge_over = computeEdge(model_prob_over, market_no_vig_prob);
          const implied_odds = market_no_vig_prob > 0 ? 1 / market_no_vig_prob : null;
          pickDebug.edges.push({
            market: 'Over/Under 2.5',
            outcome: 'Over',
            model_prob: Number(model_prob_over.toFixed(3)),
            market_prob: Number(market_no_vig_prob.toFixed(3)),
            edge: Number(edge_over.toFixed(3)),
            implied_odds: implied_odds ? Number(implied_odds.toFixed(2)) : null,
          });
          if (implied_odds && implied_odds >= minOdds && edge_over >= minEdge) {
            candidates.push({
              fixture_id: p.fixture_id,
              type: 'Over/Under 2.5',
              selection: 'Over',
              model_prob: Number(model_prob_over.toFixed(3)),
              market_prob: Number(market_no_vig_prob.toFixed(3)),
              edge: Number(edge_over.toFixed(3)),
              market_odds: Number(implied_odds.toFixed(2)),
              confidence: Number(confidence),
              teams: p.teams,
              league: p.league,
              datetime_local: p.datetime_local,
            });
          }
        }
      }

      perPickDebug.push(pickDebug);
    }

    candidates.sort((a, b) => b.edge - a.edge);
    let value_bets = candidates.slice(0, 4);

    if (value_bets.length === 0) {
      const fallback = picks
        .filter((p) => p.predicted && p.model_probs)
        .map((p) => {
          const model = p.model_probs;
          const predicted = p.predicted;
          return {
            fixture_id: p.fixture_id,
            type: 'MODEL_ONLY',
            selection:
              predicted === 'home' ? '1' : predicted === 'draw' ? 'X' : '2',
            model_prob: Number((model[predicted] || 0).toFixed(3)),
            market_prob: null,
            edge: null,
            market_odds: null,
            confidence: Number(p.confidence ?? 0),
            teams: p.teams,
            league: p.league,
            datetime_local: p.datetime_local,
            fallback: true,
            reason: 'model-only fallback',
          };
        })
        .slice(0, 3);
      value_bets = fallback;
    }

    return res.status(200).json({
      value_bets,
      all_candidates: candidates,
      source_sport_key: sport_key,
      debug: {
        select: selectResp.debug,
        per_pick: perPickDebug,
        candidate_count: candidates.length,
        thresholds: { min_edge: minEdge, min_odds: minOdds },
        used_odds_api: !!process.env.ODDS_API_KEY,
        raw_odds_events_sample: rawSample,
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
