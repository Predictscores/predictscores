// FILE: pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const store = global.__VBETS_LOCK__ || (global.__VBETS_LOCK__ = {
  dayKey: null,
  builtAt: null,
  pinned: null,
  backup: null,
  raw: null,
});

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 15));
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2)); // izuzetak za UEFA

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}
function nowISO(){ return new Date().toISOString(); }
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }

function setCDNHeaders(res) {
  const S_MAXAGE = Number(process.env.CDN_SMAXAGE_SEC || 600);
  const SWR      = Number(process.env.CDN_STALE_SEC     || 120);
  res.setHeader("Cache-Control", `s-maxage=${S_MAXAGE}, stale-while-revalidate=${SWR}`);
}
function isUEFA(name = "") {
  const n = String(name).toLowerCase();
  return n.includes("champions league") || n.includes("europa league") || n.includes("conference league");
}
function filterFuture(arr=[]) {
  const now = Date.now();
  return arr.filter(x => {
    const iso = x?.datetime_local?.starting_at?.date_time;
    const t = parseISO(iso);
    return Number.isFinite(t) && t > now;
  });
}
function rankBase(arr = []) {
  return arr.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
    const s = (b._score||0) - (a._score||0);
    if (s) return s;
    const eA = Number.isFinite(a.edge_pp)?a.edge_pp:-999;
    const eB = Number.isFinite(b.edge_pp)?b.edge_pp:-999;
    if (eB !== eA) return eB - eA;
    return String(a.fixture_id||"").localeCompare(String(b.fixture_id||""));
  });
}

// --- KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}

// --- soft-mode calibration helpers
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function adjConfidence(p, calib) {
  // bazni conf
  const base = Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null;
  if (base == null) return null;

  const mKey = (p.market_label || p.market || "").toLowerCase();
  const lKey = `${mKey}||${String(p.league?.name||"").toLowerCase()}`;
  let delta = 0;

  const marketDelta = Number(calib?.market?.[mKey]?.delta_pp ?? 0);      // npr. +2.3 (pp)
  const leagueDelta = Number(calib?.league?.[mKey]?.[String(p.league?.name||"").toLowerCase()]?.delta_vs_market_pp ?? 0);

  // ograniči efekte
  delta += clamp(marketDelta, -5, 5);
  delta += clamp(leagueDelta, -8, 8);

  // final prikaz
  return clamp(Math.round(base + delta), 1, 99);
}

function buildWhy(p, appliedDelta) {
  const edge = Number.isFinite(p.edge_pp) ? `${Math.round(p.edge_pp*10)/10}pp` : null;
  const mp = Number.isFinite(p.model_prob) ? Math.round(p.model_prob*100) : null; // %
  const imp = Number.isFinite(p.implied_prob) ? Math.round(p.implied_prob*100) : (Number.isFinite(p.market_odds) ? Math.round((1/p.market_odds)*100) : null);
  const bks = Number.isFinite(p.bookmakers_count) ? p.bookmakers_count : null;
  const drift = Number.isFinite(p.movement_pct) ? `${Math.round(p.movement_pct)}%` : "0%";

  const bits = [];
  if (edge!=null) bits.push(`EV +${edge}`);
  if (mp!=null && imp!=null) bits.push(`Model ${mp}% vs ${imp}%`);
  if (bks!=null) bits.push(`Bookies ${bks}`);
  bits.push(`Drift ${drift}`);
  if (Number.isFinite(appliedDelta) && appliedDelta!==0) {
    const s = appliedDelta>0?`+${appliedDelta}`:`${appliedDelta}`;
    bits.push(`Calib ${s}pp`);
  }
  return bits.join(" · ");
}

export default async function handler(req, res) {
  try {
    const today = beogradDayKey();
    const rebuild = String(req.query.rebuild || "").trim() === "1";

    // novi dan -> reset
    if (store.dayKey && store.dayKey !== today) {
      store.dayKey = null; store.builtAt = null;
      store.pinned = null; store.backup = null; store.raw = null;
    }

    if (!rebuild && store.dayKey === today && Array.isArray(store.pinned) && store.pinned.length > 0) {
      setCDNHeaders(res);
      return res.status(200).json({ value_bets: store.pinned, built_at: store.builtAt, day: store.dayKey, source: "locked-cache" });
    }

    // pozovi interni /api/value-bets
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const innerURL = `${origin}/api/value-bets`;

    const r = await fetch(innerURL, { headers: { "x-locked-proxy": "1" } });
    if (!r.ok) {
      const text = await r.text();
      setCDNHeaders(res);
      return res.status(r.status).json({ error: "value-bets fetch failed", details: text });
    }
    const json = await r.json();
    const raw = Array.isArray(json?.value_bets) ? json.value_bets : [];

    const future = filterFuture(raw);
    let ranked = rankBase(future);

    // cap po ligi sa UEFA izuzetkom
    const perLeague = new Map();
    const pinned = [];
    const skippedByCap = [];
    const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();

    for (const p of ranked) {
      const lname = p?.league?.name || "";
      const key = keyOfLeague(p);
      if (!isUEFA(lname)) {
        const cnt = perLeague.get(key) || 0;
        if (cnt >= MAX_PER_LEAGUE) { skippedByCap.push(p); continue; }
        perLeague.set(key, cnt + 1);
      }
      pinned.push(p);
      if (pinned.length >= LIMIT) break;
    }
    if (pinned.length < LIMIT) {
      for (const p of skippedByCap) { if (pinned.length >= LIMIT) break; pinned.push(p); }
      if (pinned.length < LIMIT) {
        for (const p of ranked) { if (pinned.length >= LIMIT) break; if (!pinned.includes(p)) pinned.push(p); }
      }
    }

    // --- SOFT MODE: učitaj kalibracije (shadow -> soft)
    const calib = await kvGet("vb:learn:calib:latest");

    // --- overlay floats + insights + why
    const enriched = [];
    for (const p of pinned.slice(0, LIMIT)) {
      // floats (ako postoje)
      const fl = await kvGet(`vb:float:${p.fixture_id}`);
      if (fl && Number.isFinite(fl.odds) && fl.odds > 0) {
        p.market_odds = fl.odds;
        p.implied_prob = Number.isFinite(fl.implied) ? fl.implied : (1/fl.odds);
        p.ev = Number.isFinite(fl.ev) ? fl.ev : p.ev;
        // ostavi p.confidence_pct kao bazu (pre kalibracije); drži movement/bookies ako su došli iz floats
        if (Number.isFinite(fl.bookmakers_count)) p.bookmakers_count = fl.bookmakers_count;
        if (Number.isFinite(fl.movement_pct)) p.movement_pct = fl.movement_pct;
      } else {
        // fallback implied ako nema
        if (!Number.isFinite(p.implied_prob) && Number.isFinite(p.market_odds) && p.market_odds>0) {
          p.implied_prob = 1 / p.market_odds;
        }
      }

      // kalibrisani confidence (prikaz i sort u kombinovanom)
      const baseConf = Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null;
      const adjConf = adjConfidence(p, calib);
      if (adjConf != null) {
        p.confidence_pct = adjConf; // koristimo ga i u UI i pri sortu na frontu
      }

      // kratki "Zašto"
      const appliedDelta = (adjConf!=null && baseConf!=null) ? (adjConf - baseConf) : 0;
      const why = buildWhy(p, appliedDelta);
      p.explain = { ...(p.explain||{}), summary: why };

      // insights linija (forma/H2H) ako postoji
      const ins = await kvGet(`vb:insight:${p.fixture_id}`);
      if (ins && ins.line) p._insight_line = ins.line;

      enriched.push(p);
    }

    // backup lista (ne diramo)
    const pinnedSet = new Set(enriched.map(p => p.fixture_id ?? `${p.league?.id}-${p.teams?.home?.name}-${p.teams?.away?.name}`));
    const backup = ranked.filter(p => {
      const id = p.fixture_id ?? `${p.league?.id}-${p.teams?.home?.name}-${p.teams?.away?.name}`;
      return !pinnedSet.has(id);
    }).slice(0, Math.max(LIMIT, 40));

    store.dayKey = today;
    store.builtAt = nowISO();
    store.pinned = enriched;
    store.backup = backup;
    store.raw = future;

    // snapshot u KV (za istoriju/learning)
    if (process.env.FEATURE_HISTORY === "1") {
      const snapshot = enriched.map(p => ({
        fixture_id: p.fixture_id,
        home: p.teams?.home?.name || "",
        away: p.teams?.away?.name || "",
        home_id: p.teams?.home?.id ?? null,
        away_id: p.teams?.away?.id ?? null,
        league_id: p.league?.id ?? null,
        league_name: p.league?.name || "",
        market: p.market_label || p.market || "",
        selection: p.selection || "",
        odds: p.market_odds || null,
        kickoff: p?.datetime_local?.starting_at?.date_time || null,
        conf: Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null
      }));
      await kvSet(`vb:day:${today}:last`, snapshot);
    }

    setCDNHeaders(res);
    return res.status(200).json({
      value_bets: store.pinned,
      built_at: store.builtAt,
      day: store.dayKey,
      source: rebuild ? "locked-rebuild" : "locked-build"
    });
  } catch (e) {
    setCDNHeaders(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e && e.message || e) });
  }
}
