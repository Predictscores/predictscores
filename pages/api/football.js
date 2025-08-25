// pages/api/football.js
// Drop-in: Predictions + Odds + EV + 12-check vetting (>=9/12) for 1X2
// - Keeps the same response shape: { ok, generated_at, window_hours, count, football: [] }
// - Uses API-FOOTBALL /v3 endpoints with hard JSON guards and a light in-memory cache.

const API_BASE = "https://v3.football.api-sports.io";
const API_KEY =
  process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
  process.env.API_FOOTBALL_KEY ||
  "";

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min cache
const MAX_PRED_FIXTURES = 12;       // shortlist to spare quota
const MIN_BOOKMAKERS = 3;           // market consensus threshold

// Vetting thresholds (can be tuned via env if želiš)
const THRESH_MODEL_MIN = parseFloat(process.env.PS_MODEL_MIN || "0.56"); // 56%
const THRESH_EDGE_PP   = parseFloat(process.env.PS_EDGE_PP   || "6");    // +6 percentage points
const THRESH_EV_PCT    = parseFloat(process.env.PS_EV_PCT    || "4");    // +4%
const THRESH_PASS_MIN  = parseInt(process.env.PS_PASS_MIN    || "9", 10);// >=9/12 checks

let _cache = { t: 0, key: "", data: null };

function nowUtc() { return new Date(); }
function addHours(date, h) { return new Date(date.getTime() + h * 3600 * 1000); }

function toBelgradeISO(isoUtc) {
  try {
    const d = new Date(isoUtc);
    const fmt = new Intl.DateTimeFormat("sr-RS", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const parts = Object.fromEntries(fmt.map(p => [p.type, p.value]));
    const dd = parts.day.padStart(2, "0");
    const mm = parts.month.padStart(2, "0");
    const yyyy = parts.year;
    const hh = parts.hour.padStart(2, "0");
    const min = parts.minute.padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  } catch { return isoUtc; }
}

async function safeJsonFetch(url, init) {
  const r = await fetch(url, init);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const raw = await r.text();
    return { ok: false, status: r.status, error: "non-JSON", raw };
  }
  const j = await r.json();
  return { ok: r.ok, status: r.status, data: j };
}

// --------- Odds helpers (market-implied 1X2) ----------
const ONE_X_TWO_BET_NAMES = new Set([
  "Match Winner", "1X2", "Full Time Result", "Result", "Winner"
]);

function parseOutcomeLabel(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "1" || s === "home" || s.includes("home")) return "home";
  if (s === "x" || s === "draw" || s.includes("draw")) return "draw";
  if (s === "2" || s === "away" || s.includes("away")) return "away";
  return null;
}

function extractBookmakerTriples(oddsResp) {
  const out = [];
  const books = Array.isArray(oddsResp?.response?.[0]?.bookmakers)
    ? oddsResp.response[0].bookmakers
    : Array.isArray(oddsResp?.response)
      ? oddsResp.response.flatMap(x => x?.bookmakers || [])
      : [];

  for (const b of books) {
    const bets = Array.isArray(b?.bets) ? b.bets : [];
    const bet = bets.find(bt => ONE_X_TWO_BET_NAMES.has(String(bt?.name || "")));
    if (!bet || !Array.isArray(bet.values)) continue;

    let home = null, draw = null, away = null;
    for (const val of bet.values) {
      const side = parseOutcomeLabel(val?.value);
      const odd = parseFloat(val?.odd);
      if (!odd || odd < 1.15 || odd > 50) continue;
      if (side === "home") home = Math.max(home || 0, odd);
      else if (side === "draw") draw = Math.max(draw || 0, odd);
      else if (side === "away") away = Math.max(away || 0, odd);
    }
    if (home && draw && away) {
      out.push({ bookmaker: b?.name || "book", home, draw, away });
    }
  }
  return out;
}

function avgMarketProbs(bookTriples) {
  // Normalize each book (remove overround), then average probs across books.
  const probs = [];
  for (const t of bookTriples) {
    const pHome = 1 / t.home, pDraw = 1 / t.draw, pAway = 1 / t.away;
    const s = pHome + pDraw + pAway;
    if (s <= 0) continue;
    probs.push({ home: pHome / s, draw: pDraw / s, away: pAway / s });
  }
  if (probs.length === 0) return null;
  const n = probs.length;
  const acc = probs.reduce((a, p) => ({
    home: a.home + p.home, draw: a.draw + p.draw, away: a.away + p.away
  }), { home: 0, draw: 0, away: 0 });
  return { home: acc.home / n, draw: acc.draw / n, away: acc.away / n, books_used: n };
}

function bestOdds(bookTriples) {
  let best = { home: 0, draw: 0, away: 0 };
  for (const t of bookTriples) {
    best.home = Math.max(best.home, t.home);
    best.draw = Math.max(best.draw, t.draw);
    best.away = Math.max(best.away, t.away);
  }
  return best;
}

// --------- Prediction shaping ----------
function shapePredictionItem(fx, pred, market) {
  const league = fx?.league || {};
  const teams = fx?.teams || {};
  const fixture = fx?.fixture || {};
  const p = pred?.predictions || {};
  const percent = p?.percent || {};
  const goals = p?.goals || {};

  const pHome = parseFloat(String(percent.home || "0").replace("%", "")) || 0;
  const pDraw = parseFloat(String(percent.draw || "0").replace("%", "")) || 0;
  const pAway = parseFloat(String(percent.away || "0").replace("%", "")) || 0;

  let selection = "DRAW";
  let model_prob = pDraw / 100;
  if (pHome >= pDraw && pHome >= pAway) {
    selection = "HOME"; model_prob = pHome / 100;
  } else if (pAway >= pHome && pAway >= pDraw) {
    selection = "AWAY"; model_prob = pAway / 100;
  }

  // Market implied
  const mp = market?.market_probs || { home: 0, draw: 0, away: 0 };
  const best = market?.best_odds || { home: 0, draw: 0, away: 0 };
  const market_prob_sel = selection === "HOME" ? mp.home : selection === "AWAY" ? mp.away : mp.draw;
  const best_odds_sel = selection === "HOME" ? best.home : selection === "AWAY" ? best.away : best.draw;

  const edge_pp = (model_prob - market_prob_sel) * 100;
  const ev_pct = best_odds_sel > 0 ? (best_odds_sel * model_prob - 1) * 100 : -999;

  // 12 checks (mostly deterministic, no heuristics)
  const checks = {
    c01_model_available: (pHome + pDraw + pAway) > 0,
    c02_bookmakers_enough: (market?.books_used || 0) >= MIN_BOOKMAKERS,
    c03_overround_removed: !!market,
    c04_edge_min: edge_pp >= THRESH_EDGE_PP,
    c05_ev_min: ev_pct >= THRESH_EV_PCT,
    c06_model_conf_min: model_prob >= THRESH_MODEL_MIN,
    c07_fixture_time_valid: !!fixture?.date,
    c08_league_present: !!league?.id && !!league?.name,
    c09_home_away_present: !!teams?.home?.name && !!teams?.away?.name,
    c10_probs_sum_ok: Math.abs((mp.home + mp.draw + mp.away) - 1) < 0.02,
    c11_odds_sane: best.home >= 1.15 && best.draw >= 1.15 && best.away >= 1.15,
    c12_unique_fixture: !!fixture?.id,
  };
  const checks_passed = Object.values(checks).filter(Boolean).length;

  return {
    type: "PREDICTIONS+ODDS",
    ok: true,
    fixture_id: fixture?.id,
    league: { id: league?.id, name: league?.name, country: league?.country },
    teams: {
      home: teams?.home?.name, away: teams?.away?.name,
      home_id: teams?.home?.id,  away_id: teams?.away?.id,
    },
    datetime_local: { starting_at: { date_time: toBelgradeISO(fixture?.date) } },

    market: "1X2",
    market_label: "1X2",
    selection,                             // "HOME" | "DRAW" | "AWAY"
    confidence_pct: Math.round(model_prob * 100),
    model_prob,

    // Market & value
    market_probs: mp,                       // {home, draw, away}
    best_odds: best,                        // {home, draw, away}
    edge_pp: Math.round(edge_pp * 10) / 10, // e.g. +6.3
    ev_pct: Math.round(ev_pct * 10) / 10,   // e.g. +4.7

    // Vetting
    checks,
    checks_passed,

    extras: {
      advice: p?.advice || null,
      goals_predicted: { home: goals?.home ?? null, away: goals?.away ?? null },
      win_or_draw: p?.win_or_draw ?? null,
      comparison: pred?.comparison || null,
      books_used: market?.books_used || 0,
    },
  };
}

// --------- Main handler ----------
export default async function handler(req, res) {
  try {
    if (!API_KEY) {
      res.setHeader("Content-Type", "application/json");
      return res.status(500).json({
        ok: false,
        error: "Missing API key (NEXT_PUBLIC_API_FOOTBALL_KEY)",
        football: [],
      });
    }

    const headers = { "x-apisports-key": API_KEY };
    const hours = Math.max(1, Math.min(24, parseInt(req.query.hours || "4", 10)));
    const now = nowUtc();
    const until = addHours(now, hours);

    const cacheKey = `pred+odds:${hours}:${Math.floor(now.getTime() / CACHE_TTL_MS)}`;
    if (_cache.data && _cache.key === cacheKey && now.getTime() - _cache.t < CACHE_TTL_MS) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json(_cache.data);
    }

    // 1) Fixtures for today (+tomorrow if window crosses midnight UTC)
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const today = `${yyyy}-${mm}-${dd}`;

    const fxToday = await safeJsonFetch(`${API_BASE}/fixtures?date=${today}`, { headers });
    if (!fxToday.ok) {
      res.setHeader("Content-Type", "application/json");
      return res.status(502).json({ ok: false, error: "fixtures fetch failed", detail: fxToday, football: [] });
    }
    let fixtures = Array.isArray(fxToday.data?.response) ? fxToday.data.response : [];

    if (until.getUTCDate() !== now.getUTCDate()) {
      const yyyy2 = until.getUTCFullYear();
      const mm2 = String(until.getUTCMonth() + 1).padStart(2, "0");
      const dd2 = String(until.getUTCDate()).padStart(2, "0");
      const tomorrow = `${yyyy2}-${mm2}-${dd2}`;
      const fxTom = await safeJsonFetch(`${API_BASE}/fixtures?date=${tomorrow}`, { headers });
      if (fxTom.ok && Array.isArray(fxTom.data?.response)) {
        fixtures = fixtures.concat(fxTom.data.response);
      }
    }
    // De-dupe fixtures by id
    const seen = new Set();
    fixtures = fixtures.filter(f => {
      const id = f?.fixture?.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // 2) Narrow to window [now, until]
    const startTs = now.getTime();
    const endTs = until.getTime();
    const within = fixtures.filter(f => {
      const iso = f?.fixture?.date;
      const ts = iso ? new Date(iso).getTime() : 0;
      return ts >= startTs && ts <= endTs;
    });

    // 3) Shortlist and fetch predictions + odds
    const shortList = within.slice(0, MAX_PRED_FIXTURES);
    const results = [];
    let totalConsidered = 0, droppedByVetting = 0, droppedNoMarket = 0, droppedNoPred = 0;

    for (const fx of shortList) {
      const fid = fx?.fixture?.id;
      if (!fid) continue;
      totalConsidered++;

      // Predictions
      const pUrl = `${API_BASE}/predictions?fixture=${fid}`;
      const pr = await safeJsonFetch(pUrl, { headers });
      const hasPred = pr.ok && Array.isArray(pr.data?.response) && pr.data.response.length > 0;
      if (!hasPred) { droppedNoPred++; continue; }

      // Odds
      const oUrl = `${API_BASE}/odds?fixture=${fid}`;
      const od = await safeJsonFetch(oUrl, { headers });
      const triples = extractBookmakerTriples(od?.data);
      if (!triples || triples.length < MIN_BOOKMAKERS) { droppedNoMarket++; continue; }

      const mp = avgMarketProbs(triples);
      const best = bestOdds(triples);
      const shaped = shapePredictionItem(fx, pr.data.response[0], {
        market_probs: mp, best_odds: best, books_used: mp?.books_used || 0
      });

      // Vetting: require >=9/12 checks
      if (shaped.checks_passed >= THRESH_PASS_MIN) {
        results.push(shaped);
      } else {
        droppedByVetting++;
      }
    }

    // 4) Sort by composite score (edge & EV priority)
    results.sort((a, b) => {
      const sA = (a.edge_pp || 0) * 60 + (a.ev_pct || 0) * 40 + (a.extras?.books_used || 0);
      const sB = (b.edge_pp || 0) * 60 + (b.ev_pct || 0) * 40 + (b.extras?.books_used || 0);
      return sB - sA;
    });

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      window_hours: hours,
      count: results.length,
      football: results, // keep same key
      meta: {
        considered: totalConsidered,
        dropped_no_predictions: droppedNoPred,
        dropped_no_market: droppedNoMarket,
        dropped_by_vetting: droppedByVetting,
        shortlist: shortList.length,
        thresholds: {
          model_min: THRESH_MODEL_MIN,
          edge_pp: THRESH_EDGE_PP,
          ev_pct: THRESH_EV_PCT,
          pass_min: THRESH_PASS_MIN,
          min_bookmakers: MIN_BOOKMAKERS
        }
      }
    };

    _cache = { t: now.getTime(), key: cacheKey, data: payload };
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(payload);

  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({ ok: false, error: String(e?.message || e), football: [] });
  }
}
