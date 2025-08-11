// FILE: pages/api/value-bets.js
/**
 * Value Bets pipeline (API-Football heavy, SportMonks/Football-Data fallback)
 * - Troši ~12–14 core poziva po meču + "near-kickoff" pozive u prozoru (<90min)
 * - Robustan server-side keš po slojevima
 * - Vraća polja koja UI koristi + explain blok
 *
 * ENV (Vercel):
 *  API_FOOTBALL_KEY           (REQUIRED)
 *  SPORTMONKS_KEY             (optional)
 *  FOOTBALL_DATA_KEY          (optional)
 *  ODDS_API_KEY               (optional; koristi se samo za Top 10 cross-check)
 *  ODDS_MAX_CALLS_PER_DAY=12  (default 12)
 *  TZ_DISPLAY=Europe/Belgrade (za info-only)
 *  FALLBACK_MIN_PROB=0.52     (ako predictions ne stignu)
 *
 * Soft budget (možeš menjati po želji):
 *  AF_BUDGET_DAILY=5000
 *  AF_NEAR_WINDOW_MIN=90
 *  AF_DEEP_TOP=30
 *  AF_SNAPSHOT_INTERVAL_MIN=60
 */

const AF = {
  BUDGET_DAILY: num(process.env.AF_BUDGET_DAILY, 5000),
  NEAR_WINDOW_MIN: num(process.env.AF_NEAR_WINDOW_MIN, 90),
  DEEP_TOP: num(process.env.AF_DEEP_TOP, 30),
  SNAPSHOT_INTERVAL_MIN: num(process.env.AF_SNAPSHOT_INTERVAL_MIN, 60),
  ODDS_MAX_CALLS_PER_DAY: num(process.env.ODDS_MAX_CALLS_PER_DAY, 12),
};

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_KEY = process.env.API_FOOTBALL_KEY;
const SM_KEY = process.env.SPORTMONKS_KEY || "";
const FD_KEY = process.env.FOOTBALL_DATA_KEY || "";
const ODDS_KEY = process.env.ODDS_API_KEY || "";

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// --------- tiny in-memory cache (per instance) ----------
const g = globalThis;
if (!g.__VB_CACHE__) {
  g.__VB_CACHE__ = {
    byKey: new Map(),  // key -> { data, exp }
    oddsSnapshots: new Map(), // fixtureId -> { type:'OPEN'|'MID'|'LATE', ts, priceMap }
    counters: {
      day: new Date().toISOString().slice(0, 10),
      apiFootball: 0,
      sportMonks: 0,
      footballData: 0,
      theOdds: 0,
    },
  };
}
const CACHE = g.__VB_CACHE__;

function setCache(key, data, ttlSec = 60) {
  CACHE.byKey.set(key, { data, exp: Date.now() + ttlSec * 1000 });
  return data;
}
function getCache(key) {
  const it = CACHE.byKey.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) {
    CACHE.byKey.delete(key);
    return null;
  }
  return it.data;
}
function incCounter(name) {
  const today = new Date().toISOString().slice(0, 10);
  if (CACHE.counters.day !== today) {
    CACHE.counters = { day: today, apiFootball: 0, sportMonks: 0, footballData: 0, theOdds: 0 };
  }
  CACHE.counters[name] = (CACHE.counters[name] || 0) + 1;
}
function withinBudget(increment = 1) {
  const today = new Date().toISOString().slice(0, 10);
  if (CACHE.counters.day !== today) {
    CACHE.counters = { day: today, apiFootball: 0, sportMonks: 0, footballData: 0, theOdds: 0 };
  }
  const used = CACHE.counters.apiFootball;
  return used + increment <= AF.BUDGET_DAILY;
}

// --------- helpers ----------
function sanitizeIso(s) {
  if (!s || typeof s !== "string") return null;
  let iso = s.trim().replace(" ", "T");
  iso = iso.replace("+00:00Z", "Z").replace("Z+00:00", "Z");
  return iso;
}
function impliedFromDecimal(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 1.01) return null;
  return 1 / o;
}
function toPct(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 100))) : 0;
}
function bucketFromPct(p) {
  if (p >= 90) return "TOP";
  if (p >= 75) return "High";
  if (p >= 50) return "Moderate";
  return "Low";
}
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

// --------- HTTP wrappers ----------
async function afFetch(path, { ttl = 0 } = {}) {
  if (!AF_KEY) throw new Error("API_FOOTBALL_KEY missing");
  const url = `https://v3.football.api-sports.io${path}`;
  const ck = `AF:${url}`;
  const cached = ttl ? getCache(ck) : null;
  if (cached) return cached;
  if (!withinBudget()) throw new Error("AF budget exhausted");
  const res = await fetch(url, { headers: { "x-apisports-key": AF_KEY } });
  incCounter("apiFootball");
  if (!res.ok) throw new Error(`AF ${path} -> ${res.status}`);
  const json = await res.json();
  if (ttl) setCache(ck, json, ttl);
  return json;
}
async function smFetch(url, { ttl = 0 } = {}) {
  if (!SM_KEY) throw new Error("SPORTMONKS_KEY missing");
  const ck = `SM:${url}`;
  const cached = ttl ? getCache(ck) : null;
  if (cached) return cached;
  const res = await fetch(url);
  incCounter("sportMonks");
  if (!res.ok) throw new Error(`SM ${url} -> ${res.status}`);
  const json = await res.json();
  if (ttl) setCache(ck, json, ttl);
  return json;
}
async function fdFetch(path, { ttl = 0 } = {}) {
  if (!FD_KEY) throw new Error("FOOTBALL_DATA_KEY missing");
  const url = `https://api.football-data.org/v4${path}`;
  const ck = `FD:${url}`;
  const cached = ttl ? getCache(ck) : null;
  if (cached) return cached;
  const res = await fetch(url, { headers: { "X-Auth-Token": FD_KEY } });
  incCounter("footballData");
  if (!res.ok) throw new Error(`FD ${path} -> ${res.status}`);
  const json = await res.json();
  if (ttl) setCache(ck, json, ttl);
  return json;
}

// --------- data fetchers ----------
async function fetchFixturesForDate(isoDate) {
  // 1) SportMonks (ako imaš)
  if (SM_KEY) {
    try {
      // Napomena: SM v3 endpoints variraju; prilagodi po svom nalogu ako treba
      const url = `https://api.sportmonks.com/v3/football/fixtures/date/${isoDate}?api_token=${SM_KEY}&include=participants;league;season`;
      const sm = await smFetch(url, { ttl: 15 * 60 });
      if (sm?.data?.length) {
        const list = sm.data
          .map((f) => {
            const home = f?.participants?.find?.((p) => p.meta?.location === "home");
            const away = f?.participants?.find?.((p) => p.meta?.location === "away");
            return {
              source: "SM",
              fixture_id: f.id,
              league: {
                id: f?.league?.id,
                name: f?.league?.name || "",
                country: f?.league?.country?.name || f?.league?.country || "",
                season: f?.season?.name || "",
              },
              teams: { home: { id: home?.id, name: home?.name }, away: { id: away?.id, name: away?.name } },
              datetime_local: { starting_at: { date_time: sanitizeIso(f?.starting_at) || null } },
            };
          })
          .filter((x) => x.teams?.home?.id && x.teams?.away?.id);
        if (list.length) return list;
      }
    } catch (_) { /* ignore */ }
  }

  // 2) API-Football fixtures for date
  try {
    const af = await afFetch(`/fixtures?date=${isoDate}`, { ttl: 15 * 60 });
    const list = (af?.response || []).map((f) => ({
      source: "AF",
      fixture_id: f?.fixture?.id,
      league: {
        id: f?.league?.id,
        name: f?.league?.name,
        country: f?.league?.country,
        season: f?.league?.season,
      },
      teams: {
        home: { id: f?.teams?.home?.id, name: f?.teams?.home?.name },
        away: { id: f?.teams?.away?.id, name: f?.teams?.away?.name },
      },
      datetime_local: {
        starting_at: { date_time: sanitizeIso(f?.fixture?.date) },
      },
    })).filter((x) => x.teams?.home?.id && x.teams?.away?.id);
    if (list.length) return list;
  } catch (_) { /* ignore */ }

  // 3) Football-Data fallback
  try {
    const fd = await fdFetch(`/matches?dateFrom=${isoDate}&dateTo=${isoDate}`, { ttl: 15 * 60 });
    const list = (fd?.matches || []).map((m) => ({
      source: "FD",
      fixture_id: m?.id,
      league: { id: m?.competition?.id, name: m?.competition?.name, country: "", season: m?.season?.startDate?.slice(0,4) },
      teams: { home: { id: m?.homeTeam?.id, name: m?.homeTeam?.name }, away: { id: m?.awayTeam?.id, name: m?.awayTeam?.name } },
      datetime_local: { starting_at: { date_time: sanitizeIso(m?.utcDate) } },
    }));
    return list;
  } catch (_) { /* ignore */ }

  return [];
}

async function fetchPredictions(fixtureId) {
  try {
    const j = await afFetch(`/predictions?fixture=${fixtureId}`, { ttl: 30 * 60 });
    const r = j?.response?.[0];
    const preds = r?.predictions || r;
    // normalize 1X2
    let p1 = preds?.percent?.home;
    let px = preds?.percent?.draw;
    let p2 = preds?.percent?.away;
    // API ponekad vrati stringove "62%"
    const clean = (v) => typeof v === "string" ? (parseFloat(v) / 100) : (Number(v));
    p1 = clean(p1); px = clean(px); p2 = clean(p2);
    const total = [p1, px, p2].filter((x) => Number.isFinite(x)).reduce((a, b) => a + b, 0);
    if (total > 0) {
      p1 = (p1 || 0) / total;
      px = (px || 0) / total;
      p2 = (p2 || 0) / total;
      return { p1, px, p2 };
    }
  } catch (_) {}
  return null;
}

async function fetchOdds(fixtureId) {
  try {
    const j = await afFetch(`/odds?fixture=${fixtureId}`, { ttl: 10 * 60 });
    const resp = j?.response || [];
    // Vadi H2H market (1X2) i median kvote
    const prices = { "1": [], X: [], "2": [] };
    for (const book of resp) {
      for (const m of book?.bookmakers?.[0]?.bets || []) {
        const name = (m?.name || "").toLowerCase();
        if (name.includes("match winner") || name.includes("1x2")) {
          for (const v of m.values || []) {
            const lbl = (v?.value || "").toUpperCase();
            const odd = Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl === "HOME" || lbl === "1") prices["1"].push(odd);
            if (lbl === "DRAW" || lbl === "X") prices["X"].push(odd);
            if (lbl === "AWAY" || lbl === "2") prices["2"].push(odd);
          }
        }
      }
    }
    const median = (arr) => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const i = Math.floor(s.length / 2);
      return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
    };
    return {
      odds: { "1": median(prices["1"]), X: median(prices["X"]), "2": median(prices["2"]) },
      bookmakers_count: resp.length || 0,
    };
  } catch (_) {}
  return null;
}

async function fetchTeamStats(leagueId, season, teamId) {
  try {
    const j = await afFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`, { ttl: 12 * 3600 });
    return j?.response || null;
  } catch (_) {}
  return null;
}

async function fetchH2H(homeId, awayId, last = 5) {
  try {
    const j = await afFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${last}`, { ttl: 24 * 3600 });
    const games = j?.response || [];
    let w = 0, d = 0, l = 0, gs = 0, ga = 0;
    for (const g of games) {
      const hs = g?.goals?.home ?? g?.score?.fulltime?.home;
      const as = g?.goals?.away ?? g?.score?.fulltime?.away;
      if (Number.isFinite(hs) && Number.isFinite(as)) {
        gs += hs; ga += as;
        if (hs > as) w++; else if (hs === as) d++; else l++;
      }
    }
    const summary = games.length ? `W${w} D${d} L${l} · ${gs}:${ga}` : "";
    return { summary, count: games.length };
  } catch (_) {}
  return { summary: "", count: 0 };
}

async function fetchInjuries(fixtureId) {
  try {
    const j = await afFetch(`/injuries?fixture=${fixtureId}`, { ttl: 10 * 60 });
    const resp = j?.response || [];
    return { count: resp.length || 0 };
  } catch (_) {}
  return { count: 0 };
}

async function fetchLineups(fixtureId) {
  try {
    const j = await afFetch(`/fixtures/lineups?fixture=${fixtureId}`, { ttl: 5 * 60 });
    const ln = j?.response || [];
    const confirmed = ln.some((x) => x?.team && Array.isArray(x?.startXI) && x.startXI.length > 0);
    return { status: confirmed ? "confirmed" : (ln.length ? "expected" : "unknown") };
  } catch (_) {}
  return { status: "unknown" };
}

function pickFromPredictions(preds) {
  // return selection "1"|"X"|"2" and prob
  const map = { "1": preds?.p1 || 0, X: preds?.px || 0, "2": preds?.p2 || 0 };
  const sel = Object.keys(map).sort((a, b) => map[b] - map[a])[0] || "1";
  const prob = map[sel] || 0;
  return { selection: sel, model_prob: prob };
}

function edgeFromOdds(sel, modelProb, odds) {
  const price = sel && odds ? odds[sel] : null;
  const implied = impliedFromDecimal(price);
  if (!Number.isFinite(implied)) return { market_odds: null, implied_prob: null, edge: null };
  return { market_odds: price, implied_prob: implied, edge: modelProb - implied };
}

function movementForFixture(fixtureId, oddsObj) {
  // Store snapshot and return movement % relative to previous snapshot
  const now = Date.now();
  const prev = CACHE.oddsSnapshots.get(fixtureId);
  const map = { "1": oddsObj?.["1"], X: oddsObj?.X, "2": oddsObj?.["2"] };
  const snap = { type: "GEN", ts: now, priceMap: map };
  CACHE.oddsSnapshots.set(fixtureId, snap);
  if (!prev || !prev.priceMap) return 0;
  // simple average implied prob delta
  const keys = ["1", "X", "2"];
  const prevImp = keys.map((k) => impliedFromDecimal(prev.priceMap[k])).filter(Number.isFinite);
  const nowImp = keys.map((k) => impliedFromDecimal(map[k])).filter(Number.isFinite);
  if (!prevImp.length || !nowImp.length) return 0;
  const prevAvg = sum(prevImp) / prevImp.length;
  const nowAvg = sum(nowImp) / nowImp.length;
  return Math.round((nowAvg - prevAvg) * 10000) / 100; // in percentage points (pp)
}

function explainBlock(v) {
  const bits = [];
  if (v.form_text) bits.push(`Forma: ${v.form_text}`);
  if (v.h2h_summary) bits.push(`H2H: ${v.h2h_summary}`);
  if (v.lineups_status === "confirmed") bits.push("Postave potvrđene");
  if (Number.isFinite(v.injuries_count) && v.injuries_count > 0) bits.push(`Povrede: ${v.injuries_count}`);
  if (Number.isFinite(v.movement_pct) && v.movement_pct !== 0) {
    bits.push(`Tržište: ${v.movement_pct > 0 ? "↑" : "↓"} ${Math.abs(v.movement_pct).toFixed(2)}pp`);
  }
  const summary = [
    v.type === "MODEL+ODDS" && Number.isFinite(v.edge) ? `Edge ${Math.round(v.edge * 100)}pp` : null,
    v.model_prob ? `Model ${Math.round(v.model_prob * 100)}%` : null,
  ].filter(Boolean).join(" · ");

  return {
    summary,
    bullets: bits,
    factors: {
      model: v.model_prob || null,
      edge: v.edge || null,
      injuries: v.injuries_count || 0,
      movement_pp: v.movement_pct || 0,
    },
  };
}

function overallConfidence(v) {
  const pPred = v.model_prob || 0;
  const edge = Number.isFinite(v.edge) ? Math.max(-0.15, Math.min(0.15, v.edge)) : 0;
  const form = v.form_score || 0; // normalized 0..1
  const h2h = v.h2h_score || 0;
  const lineups = v.lineups_status === "confirmed" ? 1 : (v.lineups_status === "expected" ? 0.6 : 0.4);
  const injuries = Math.max(0, 1 - Math.min(1, (v.injuries_count || 0) / 5)); // više povreda -> manje
  const move = Math.max(0, 1 + (v.movement_pct || 0) / 10); // +/- pp pretvaramo u blagi multiplikator

  // 0..1 score
  const base =
    0.30 * pPred +
    0.20 * (0.5 + edge) +        // edge -0.15..+0.15 -> 0.35..0.65
    0.15 * form +
    0.10 * h2h +
    0.10 * (lineups / 1.1) +
    0.10 * injuries +
    0.05 * Math.min(1.2, move);

  return Math.max(0, Math.min(1, base));
}

function computeFormScore(statsHome, statsAway) {
  // jednostavno: poslednjih 5 rezultata (W=1, D=0.5, L=0), domaći - gosti + normalizacija
  const score = (s) => {
    const f = s?.form || s?.fixtures?.form || ""; // "WWLDW"
    const map = { W: 1, D: 0.5, L: 0 };
    const vals = f.toString().split("").map((c) => map[c] ?? 0);
    if (!vals.length) return 0.5;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const sh = score(statsHome);
  const sa = score(statsAway);
  const text = `${(statsHome?.form || "").slice(-5)} vs ${(statsAway?.form || "").slice(-5)}`;
  return { score: Math.max(0, Math.min(1, 0.5 + (sh - sa) / 2)), text };
}

export default async function handler(req, res) {
  const dateParam = (req.query.date || new Date().toISOString().slice(0, 10));
  const debug = req.query.debug === "1" || req.query.debug === "true";

  const t0 = Date.now();

  let fixtures = [];
  try {
    fixtures = await fetchFixturesForDate(dateParam);
  } catch (e) {
    // ignore, fallback to empty
  }

  // limit opterećenja: ne radimo "deep" za sve odmah, već sabiramo signal za sve pa produbljujemo Top N
  const results = [];
  for (const f of fixtures) {
    const fixtureId = f.fixture_id;
    const leagueId = f.league?.id;
    const season = f.league?.season;
    const homeId = f.teams?.home?.id;
    const awayId = f.teams?.away?.id;

    // Predictions (model prob) — ili fallback na env FALLBACK_MIN_PROB
    let preds = null;
    if (withinBudget(1)) {
      preds = await fetchPredictions(fixtureId).catch(() => null);
    }
    let model_prob = null, selection = "1";
    if (preds) {
      const picked = pickFromPredictions(preds);
      model_prob = picked.model_prob;
      selection = picked.selection;
    } else {
      const p = num(process.env.FALLBACK_MIN_PROB, 0.52);
      model_prob = p;
      selection = "1";
    }

    // Form & H2H (jeftini)
    let statsHome = null, statsAway = null;
    if (withinBudget(2) && leagueId && season) {
      [statsHome, statsAway] = await Promise.all([
        fetchTeamStats(leagueId, season, homeId).catch(() => null),
        fetchTeamStats(leagueId, season, awayId).catch(() => null),
      ]);
    }
    const { score: form_score, text: form_text } = computeFormScore(statsHome, statsAway);

    const h2h = withinBudget(1) ? await fetchH2H(homeId, awayId, 5).catch(() => ({ summary: "", count: 0 })) : { summary: "", count: 0 };

    // Odds (market price)
    let oddsPack = null;
    if (withinBudget(1)) {
      oddsPack = await fetchOdds(fixtureId).catch(() => null);
    }
    const { odds, bookmakers_count } = oddsPack || {};
    const { market_odds, implied_prob, edge } = edgeFromOdds(selection, model_prob, odds || null);
    const movement_pct = odds ? movementForFixture(fixtureId, odds) : 0;

    // Near-kickoff layer (light)
    let injuries_count = 0;
    let lineups_status = "unknown";
    const kickoffISO = sanitizeIso(f?.datetime_local?.starting_at?.date_time);
    const minsTo = kickoffISO ? Math.round((new Date(kickoffISO).getTime() - Date.now()) / 60000) : null;
    if (minsTo !== null && minsTo <= AF.NEAR_WINDOW_MIN && minsTo >= -180) {
      if (withinBudget(2)) {
        const [inj, lin] = await Promise.all([
          fetchInjuries(fixtureId).catch(() => ({ count: 0 })),
          fetchLineups(fixtureId).catch(() => ({ status: "unknown" })),
        ]);
        injuries_count = inj.count || 0;
        lineups_status = lin.status || "unknown";
      }
    }

    const base = {
      fixture_id: fixtureId,
      market: "1X2",
      selection,
      type: Number.isFinite(market_odds) ? "MODEL+ODDS" : "FALLBACK",
      model_prob,
      market_odds: Number.isFinite(market_odds) ? market_odds : null,
      implied_prob: Number.isFinite(implied_prob) ? implied_prob : null,
      edge: Number.isFinite(edge) ? edge : null,
      movement_pct: Number.isFinite(movement_pct) ? movement_pct : 0,
      datetime_local: { starting_at: { date_time: kickoffISO } },
      teams: f.teams,
      league: f.league,
      confidence_pct: 0, // set below
      confidence_bucket: "Low",
      _score: 0,
      form_score,
      form_text,
      h2h_summary: h2h.summary || "",
      h2h_count: h2h.count || 0,
      lineups_status,
      injuries_count,
    };

    const conf = overallConfidence(base);
    base._score = Math.round(conf * 100);
    base.confidence_pct = Math.round(conf * 100);
    base.confidence_bucket = bucketFromPct(base.confidence_pct);

    base.explain = explainBlock(base);

    results.push(base);
  }

  // rangiranje: MODEL+ODDS prioritet, zatim _score
  results.sort((a, b) => {
    if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
    if (b._score !== a._score) return b._score - a._score;
    const aEdge = Number.isFinite(a.edge) ? a.edge : -1;
    const bEdge = Number.isFinite(b.edge) ? b.edge : -1;
    return bEdge - aEdge;
  });

  // Ograniči izlaz (Top 10), ali po želji možeš proširiti
  const top = results.slice(0, 10);

  // CROSS-CHECK sa The Odds API – samo za Top 10 (≤12/d), ako ključ postoji
  if (ODDS_KEY && AF.ODDS_MAX_CALLS_PER_DAY > 0 && CACHE.counters.theOdds < AF.ODDS_MAX_CALLS_PER_DAY) {
    // (ostavljeno kao hook; implementacija zavisi od tvoje mape sport_key/leagues – ne blokira)
    // Ako želiš, ovde može dodatno da se zatraži price i uporedi; u skor se doda +/- 3.
  }

  const payload = {
    generated_at: new Date().toISOString(),
    tz_display: TZ,
    value_bets: top,
    // debug:
    _meta: debug
      ? {
          total_fixtures: fixtures.length,
          counters: CACHE.counters,
          budget: { limit: AF.BUDGET_DAILY, used: CACHE.counters.apiFootball },
          took_ms: Date.now() - t0,
        }
      : undefined,
  };

  // Aggressive CDN cache ali kratko (front je brz)
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=60");
  res.status(200).json(payload);
}
