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
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function similarity(a = '', b = '') {
  if (!a || !b) return 0;
  const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function normalizeName(name = '') {
  return name.toLowerCase().replace(/[\W_]+/g, '');
}

function computeEdge(model_prob, market_no_vig_prob) {
  return market_no_vig_prob == null ? null : model_prob - market_no_vig_prob;
}

/* Consensus extraction */
function extractConsensusNoVig(oddsEvent) {
  if (!oddsEvent || !Array.isArray(oddsEvent.bookmakers)) return {};
  const aggregate = { h2h: { home: [], draw: [], away: [] }, over25: [], btts_yes: [] };

  for (const bookmaker of oddsEvent.bookmakers) {
    if (!Array.isArray(bookmaker.markets)) continue;
    for (const market of bookmaker.markets) {
      // 1X2
      if (market.key === 'h2h') {
        const implied = {};
        (market.outcomes || []).forEach((o) => {
          const name = o.name.toLowerCase();
          const price = parseFloat(o.price);
          if (!price) return;
          if (name === 'draw') implied.draw = 1 / price;
          else if (name === (oddsEvent.home_team || '').toLowerCase()) implied.home = 1 / price;
          else if (name === (oddsEvent.away_team || '').toLowerCase()) implied.away = 1 / price;
        });
        const sum = (implied.home||0)+(implied.draw||0)+(implied.away||0);
        if (sum>0) {
          if (implied.home) aggregate.h2h.home.push(implied.home/sum);
          if (implied.draw) aggregate.h2h.draw.push(implied.draw/sum);
          if (implied.away) aggregate.h2h.away.push(implied.away/sum);
        }
      }
      // Totals (Over/Under 2.5)
      if (market.key === 'totals') {
        const over = market.outcomes.find((o) => o.name.toLowerCase().startsWith('over 2.5'));
        const under = market.outcomes.find((o) => o.name.toLowerCase().startsWith('under 2.5'));
        if (over && under) {
          const pO = 1/parseFloat(over.price), pU = 1/parseFloat(under.price);
          const s = pO+pU;
          if (s>0) aggregate.over25.push(pO/s);
        }
      }
      // BTTS (bothteamscore)
      if (market.key === 'bothteamscore' || market.key.toLowerCase().includes('btts')) {
        const yes = market.outcomes.find((o) => o.name.toLowerCase() === 'yes');
        const no  = market.outcomes.find((o) => o.name.toLowerCase() === 'no');
        if (yes && no) {
          const pY = 1/parseFloat(yes.price), pN = 1/parseFloat(no.price);
          const s = pY+pN;
          if (s>0) aggregate.btts_yes.push(pY/s);
        }
      }
    }
  }

  const out = {};
  if (aggregate.h2h.home.length) out.home = aggregate.h2h.home.reduce((a,b)=>a+b)/aggregate.h2h.home.length;
  if (aggregate.h2h.draw.length) out.draw = aggregate.h2h.draw.reduce((a,b)=>a+b)/aggregate.h2h.draw.length;
  if (aggregate.h2h.away.length) out.away = aggregate.h2h.away.reduce((a,b)=>a+b)/aggregate.h2h.away.length;
  if (aggregate.over25.length) out.over25 = aggregate.over25.reduce((a,b)=>a+b)/aggregate.over25.length;
  if (aggregate.btts_yes.length) out.btts_yes = aggregate.btts_yes.reduce((a,b)=>a+b)/aggregate.btts_yes.length;
  return out;
}

/* Fetch odds with debug, corrected markets */
async function fetchAllOddsEventsWithDebug() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { events: [], error: 'missing ODDS_API_KEY' };
  const url = new URL('https://api.the-odds-api.com/v4/sports/soccer/odds/');
  url.searchParams.set('regions', 'eu');
  url.searchParams.set('markets', 'h2h,totals,bothteamscore'); // <-- corrected here
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('daysFrom', '0');
  url.searchParams.set('daysTo', '1');

  try {
    const res = await fetch(url.toString());
    const text = await res.text();
    if (!res.ok) return { events: [], error: `status ${res.status}`, status: res.status, rawText: text.slice(0,500) };
    const parsed = JSON.parse(text);
    return { events: Array.isArray(parsed)?parsed:[], error: null, status: res.status, rawText: text.slice(0,500) };
  } catch (e) {
    return { events: [], error: e.message };
  }
}

/* Fuzzy matching */
function findBestMatchEvent(pick, events) {
  const tH = normalizeName(pick.teams.home.name), tA = normalizeName(pick.teams.away.name);
  let best=null, score=0;
  for (const ev of events) {
    const eH=normalizeName(ev.home_team), eA=normalizeName(ev.away_team);
    const direct=(similarity(eH,tH)+similarity(eA,tA))/2;
    const swapped=(similarity(eH,tA)+similarity(eA,tH))/2;
    const s = Math.max(direct, swapped);
    if (s>score) { score=s; best={ ev, direct, score }; }
  }
  return best;
}

export default async function handler(req, res) {
  try {
    const { date, min_edge: me, min_odds: mo } = req.query;
    const minEdge = parseFloat(me ?? '0.03'), minOdds = parseFloat(mo ?? '1.2');
    const sel = await selectMatchesForDate(date);
    const picks = sel.picks||[];

    // fetch odds
    const { events, error: oddsError, status: oddsStatus, rawText: oddsRaw } =
      await fetchAllOddsEventsWithDebug();
    const rawSample = events.slice(0,5).map(e=>({
      home:e.home_team, away:e.away_team, commence_time:e.commence_time, bcount: e.bookmakers?.length||0
    }));

    const candidates = [], perPickDebug=[];

    for (const p of picks) {
      const { model_probs:m, predicted, confidence } = p;
      const pickDebug = { fixture_id:p.fixture_id, teams:p.teams, predicted, edges:[], consensus:{}, matched_event:null, best_match_score:null };
      let matched=null;
      if (events.length) {
        const best = findBestMatchEvent(p, events);
        if (best && best.score>=0.6) {
          matched = best.ev;
          pickDebug.best_match_score = Number(best.score.toFixed(3));
          pickDebug.matched_event = { home:matched.home_team, away:matched.away_team, commence_time:matched.commence_time };
        } else if (best) {
          pickDebug.best_match_score = Number(best.score.toFixed(3));
        }
      }

      const cons = extractConsensusNoVig(matched);
      pickDebug.consensus = cons;

      // generate edges & candidates
      for (const [market,probKeys] of [
        ['1X2',['home','draw','away']],
        ['BTTS',['btts_yes']],
        ['Over/Under 2.5',['over25']]
      ]) {
        for (const k of probKeys) {
          const modelP = k==='btts_yes'? p.btts_probability : k==='over25'? p.over25_probability : m[k];
          const marketP = cons[k];
          if (modelP!=null && marketP!=null) {
            const edge = computeEdge(modelP, marketP);
            const odds = marketP>0?1/marketP:null;
            pickDebug.edges.push({ market, outcome:k, modelP, marketP, edge, odds });
            if (odds&&odds>=minOdds && edge>=minEdge) {
              candidates.push({
                fixture_id:p.fixture_id, type:market,
                selection: market==='1X2'?(predicted==='home'?'1':predicted==='draw'?'X':'2'):(market==='BTTS'?'Yes':'Over'),
                model_prob:Number(modelP.toFixed(3)), market_prob:Number(marketP.toFixed(3)),
                edge:Number(edge.toFixed(3)), market_odds:Number(odds.toFixed(2)),
                confidence, teams:p.teams, league:p.league, datetime_local:p.datetime_local
              });
            }
          }
        }
      }

      perPickDebug.push(pickDebug);
    }

    candidates.sort((a,b)=>b.edge-a.edge);
    let value_bets = candidates.slice(0,4);
    if (!value_bets.length) {
      value_bets = picks.slice(0,3).map(p=>({
        fixture_id:p.fixture_id, type:'MODEL_ONLY',
        selection: p.predicted==='home'?'1':p.predicted==='draw'?'X':'2',
        model_prob:Number((p.model_probs[p.predicted]||0).toFixed(3)),
        fallback:true, reason:'model-only fallback',
        teams:p.teams, league:p.league, datetime_local:p.datetime_local, confidence:p.confidence
      }));
    }

    return res.status(200).json({
      value_bets, all_candidates:candidates,
      debug:{
        select:sel.debug,
        raw_odds_events_sample:rawSample,
        raw_odds_fetch:{ error:oddsError, status:oddsStatus, snippet:oddsRaw },
        thresholds:{ min_edge:minEdge, min_odds:minOdds }
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error:'internal', message:e.message });
  }
}
