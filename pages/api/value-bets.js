// pages/api/value-bets.js

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const MIN_MARKET_ODDS = 1.3; // minimalna kvota za razmatranje
const EDGE_THRESHOLD = 0.05; // value bet cutoff

function safePct(p) {
  return Math.min(Math.max(p, 0), 1);
}

function normalizeNoVig(probs) {
  // probs: { outcome: impliedProbability, ... }
  const sum = Object.values(probs).reduce((s, v) => s + v, 0);
  if (sum <= 0) return probs;
  const normalized = {};
  Object.entries(probs).forEach(([k, v]) => {
    normalized[k] = v / sum;
  });
  return normalized;
}

// average consensus no-vig probability across bookmakers for a given outcome
function consensusProb(bookmakerNoVigs, outcome) {
  if (!bookmakerNoVigs || bookmakerNoVigs.length === 0) return 0;
  let sum = 0;
  let count = 0;
  bookmakerNoVigs.forEach((nv) => {
    if (nv[outcome] != null) {
      sum += nv[outcome];
      count += 1;
    }
  });
  return count > 0 ? sum / count : 0;
}

async function fetchOddsBulk(sportKey = 'soccer') {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error('ODDS_API_KEY missing');
  const url = new URL(`${ODDS_API_BASE}/sports/${sportKey}/odds/`);
  url.searchParams.set('regions', 'eu'); // adjust if needed
  url.searchParams.set('markets', 'h2h,bothteams,totals'); // 1X2, BTTS, Totals (over/under)
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');
  url.searchParams.set('apiKey', apiKey);
  // Note: depending on version/naming of the Odds API, you might need to adjust "bothteams" or "totals"
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odds API error ${res.status}: ${text}`);
  }
  return res.json(); // array of events
}

function matchEventToPick(event, pick) {
  // crude matching on team names (case-insensitive inclusion)
  const home = event.home_team?.toLowerCase();
  const away = event.away_team?.toLowerCase();
  const pickHome = (pick.teams?.home?.name || '').toLowerCase();
  const pickAway = (pick.teams?.away?.name || '').toLowerCase();

  // direct exact or inclusion matches
  const homeMatches =
    home === pickHome || home.includes(pickHome) || pickHome.includes(home);
  const awayMatches =
    away === pickAway || away.includes(pickAway) || pickAway.includes(away);
  const flipHomeMatches =
    home === pickAway || home.includes(pickAway) || pickAway.includes(home);
  const flipAwayMatches =
    away === pickHome || away.includes(pickHome) || pickHome.includes(away);

  // allow swapped if necessary (some naming mismatches)
  return (homeMatches && awayMatches) || (flipHomeMatches && flipAwayMatches);
}

function impliedProbFromOdd(odd) {
  if (!odd || odd <= 0) return 0;
  return 1 / odd;
}

export default async function handler(req, res) {
  try {
    const { picks, sport_key = 'soccer' } = req.method === 'GET' ? req.query : req.body || {};

    if (!picks || !Array.isArray(picks) || picks.length === 0) {
      return res.status(400).json({
        error: 'no_picks',
        message: 'You must supply picks array from /api/select-matches as body.picks',
      });
    }

    // Fetch odds in bulk once per sport
    const allOddsEvents = await fetchOddsBulk(sport_key);

    const value_bets = [];
    const all_candidates = [];

    for (const pick of picks) {
      // find matching event from odds API
      const matchedEvents = allOddsEvents.filter((ev) => matchEventToPick(ev, pick));

      if (matchedEvents.length === 0) {
        // no market data found
        all_candidates.push({
          fixture_id: pick.fixture_id,
          reason: 'no matching odds event',
          pick,
        });
        continue;
      }

      // For simplicity take first matching event
      const event = matchedEvents[0];

      // gather bookmakers that have the markets we need
      const bookies = event.bookmakers || [];

      // Prepare storage for per-market consensus
      const marketsSummary = {};

      // --- 1X2 market (h2h) ---
      const h2hNoVigs = [];
      bookies.forEach((bk) => {
        const h2h = bk.markets?.find((m) => m.key === 'h2h');
        if (!h2h || !Array.isArray(h2h.outcomes)) return;
        // build implied probs
        const probs = {};
        h2h.outcomes.forEach((o) => {
          probs[o.name.toLowerCase()] = impliedProbFromOdd(o.price);
        });
        const noVig = normalizeNoVig(probs); // { home:..., draw:..., away:... }
        h2hNoVigs.push(noVig);
      });

      const model_probs = pick.model_probs || {};
      // map predicted outcomes naming collision: we expect market outcome names like home/draw/away
      // consensus for each of home/draw/away
      const consensus_h2h = {
        home: consensusProb(h2hNoVigs, 'home'),
        draw: consensusProb(h2hNoVigs, 'draw'),
        away: consensusProb(h2hNoVigs, 'away'),
      };

      // For each outcome, compute edge vs model
      ['home', 'draw', 'away'].forEach((outcome) => {
        const model_p = safePct(model_probs[outcome] ?? 0);
        const market_p = safePct(consensus_h2h[outcome]);
        // final blended
        const final_p = (model_p + market_p) / 2;
        const edge = final_p - market_p; // positive means model lifts above market
        // implied odds from consensus (no-vig)
        const impliedOdds = market_p > 0 ? 1 / market_p : null;

        if (edge >= EDGE_THRESHOLD && impliedOdds && impliedOdds >= MIN_MARKET_ODDS) {
          value_bets.push({
            fixture_id: pick.fixture_id,
            market: '1X2',
            outcome,
            model_probability: Number(model_p.toFixed(3)),
            consensus_probability: Number(market_p.toFixed(3)),
            final_probability: Number(final_p.toFixed(3)),
            edge: Number(edge.toFixed(3)),
            implied_odds: impliedOdds ? Number(impliedOdds.toFixed(2)) : null,
            predicted: pick.predicted,
          });
        }

        all_candidates.push({
          fixture_id: pick.fixture_id,
          market: '1X2',
          outcome,
          model_probability: Number(model_p.toFixed(3)),
          consensus_probability: Number(market_p.toFixed(3)),
          edge: Number(( (model_p + market_p)/2 - market_p ).toFixed(3)),
          implied_odds: impliedOdds ? Number(impliedOdds.toFixed(2)) : null,
        });
      });

      // --- BTTS ---
      // Model probability available as btts_probability
      const model_btts = safePct(pick.btts_probability ?? 0);
      // try to pull BTTS market from bookmakers
      const bttsNoVigs = [];
      bookies.forEach((bk) => {
        const btts = bk.markets?.find((m) => m.key === 'bothteams' || m.key === 'both_teams_to_score');
        if (!btts || !Array.isArray(btts.outcomes)) return;
        // Assume outcomes names like "Yes"/"No"
        const probs = {};
        btts.outcomes.forEach((o) => {
          probs[o.name.toLowerCase()] = impliedProbFromOdd(o.price);
        });
        const noVig = normalizeNoVig(probs); // yes/no
        bttsNoVigs.push(noVig);
      });
      const consensus_btts_yes = consensusProb(bttsNoVigs, 'yes');
      const final_btts_p = (model_btts + consensus_btts_yes) / 2;
      const edge_btts = final_btts_p - consensus_btts_yes;
      const impliedOddsBTTS = consensus_btts_yes > 0 ? 1 / consensus_btts_yes : null;
      if (edge_btts >= EDGE_THRESHOLD && impliedOddsBTTS && impliedOddsBTTS >= MIN_MARKET_ODDS) {
        value_bets.push({
          fixture_id: pick.fixture_id,
          market: 'BTTS',
          outcome: 'yes',
          model_probability: Number(model_btts.toFixed(3)),
          consensus_probability: Number(consensus_btts_yes.toFixed(3)),
          final_probability: Number(final_btts_p.toFixed(3)),
          edge: Number(edge_btts.toFixed(3)),
          implied_odds: impliedOddsBTTS ? Number(impliedOddsBTTS.toFixed(2)) : null,
        });
      }
      all_candidates.push({
        fixture_id: pick.fixture_id,
        market: 'BTTS',
        outcome: 'yes',
        model_probability: Number(model_btts.toFixed(3)),
        consensus_probability: Number(consensus_btts_yes.toFixed(3)),
        edge: Number(edge_btts.toFixed(3)),
        implied_odds: impliedOddsBTTS ? Number(impliedOddsBTTS.toFixed(2)) : null,
      });

      // --- Over/Under 2.5 ---
      const model_over25 = safePct(pick.over25_probability ?? 0); // model probability over 2.5
      const totalsNoVigs = [];
      bookies.forEach((bk) => {
        const totals = bk.markets?.find((m) => m.key === 'totals');
        if (!totals || !Array.isArray(totals.outcomes)) return;
        // Need to find outcome corresponding to Over 2.5 (naming varies, e.g., "Over 2.5")
        const relevant = {};
        totals.outcomes.forEach((o) => {
          const nameLower = o.name.toLowerCase();
          if (nameLower.includes('over') && nameLower.includes('2.5')) {
            relevant['over'] = impliedProbFromOdd(o.price);
          } else if (nameLower.includes('under') && nameLower.includes('2.5')) {
            relevant['under'] = impliedProbFromOdd(o.price);
          }
        });
        if (Object.keys(relevant).length === 0) return;
        const noVig = normalizeNoVig(relevant); // over/under
        totalsNoVigs.push(noVig);
      });
      const consensus_over = consensusProb(totalsNoVigs, 'over') || 0;
      const final_over_p = (model_over25 + consensus_over) / 2;
      const edge_over = final_over_p - consensus_over;
      const impliedOddsOver = consensus_over > 0 ? 1 / consensus_over : null;
      if (edge_over >= EDGE_THRESHOLD && impliedOddsOver && impliedOddsOver >= MIN_MARKET_ODDS) {
        value_bets.push({
          fixture_id: pick.fixture_id,
          market: 'Over/Under 2.5',
          outcome: 'over',
          model_probability: Number(model_over25.toFixed(3)),
          consensus_probability: Number(consensus_over.toFixed(3)),
          final_probability: Number(final_over_p.toFixed(3)),
          edge: Number(edge_over.toFixed(3)),
          implied_odds: impliedOddsOver ? Number(impliedOddsOver.toFixed(2)) : null,
        });
      }
      all_candidates.push({
        fixture_id: pick.fixture_id,
        market: 'Over/Under 2.5',
        outcome: 'over',
        model_probability: Number(model_over25.toFixed(3)),
        consensus_probability: Number(consensus_over.toFixed(3)),
        edge: Number(edge_over.toFixed(3)),
        implied_odds: impliedOddsOver ? Number(impliedOddsOver.toFixed(2)) : null,
      });
    }

    // Sort value_bets by edge descending
    value_bets.sort((a, b) => b.edge - a.edge);

    return res.status(200).json({
      value_bets,
      all_candidates,
      source_sport_key: sport_key,
      debug: {
        timestamp: new Date().toISOString(),
        picks_count: picks.length,
      },
    });
  } catch (err) {
    console.error('value-bets error:', err);
    return res.status(500).json({
      error: 'internal',
      message: err.message,
    });
  }
}
