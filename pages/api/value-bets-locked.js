// =============================================
// Locked snapshot + Smart overlay (floats, tiering by (league,country), caps, dynamic limit)
// Fix: Canadian Premier League više NE upada u Tier1 (striktna (league,country) mapa)
// =============================================

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const VB_LIMIT_FALLBACK = parseInt(process.env.VB_LIMIT || "25", 10);
const VB_LIMIT_WEEKDAY = parseInt(process.env.VB_LIMIT_WEEKDAY || "15", 10);
const VB_LIMIT_WEEKEND = parseInt(process.env.VB_LIMIT_WEEKEND || "25", 10);
const VB_MAX_PER_LEAGUE = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);

const TIER3_MAX_TOTAL = parseInt(process.env.TIER3_MAX_TOTAL || "6", 10);
const TIER3_MIN_BOOKIES = parseInt(process.env.TIER3_MIN_BOOKIES || "4", 10);
const TIER3_MIN_EDGE_PP = parseFloat(process.env.TIER3_MIN_EDGE_PP || "8");
const TIER3_MIN_EV = parseFloat(process.env.TIER3_MIN_EV || "0.08");
const TIER3_MIN_ODDS = parseFloat(process.env.TIER3_MIN_ODDS || "0"); // 0 = off

// --- Striktna mapa Tier 1/2: ime lige + zemlja (bez MLS-a) ---
const TIER1_COMBOS = [
  { country: "England",     names: ["Premier League"] },
  { country: "Spain",       names: ["La Liga"] },
  { country: "Germany",     names: ["Bundesliga"] },
  { country: "Italy",       names: ["Serie A"] },
  { country: "France",      names: ["Ligue 1"] },
  { country: "Serbia",      names: ["SuperLiga","Super Liga"] },
  { country: "Netherlands", names: ["Eredivisie"] },
];
// Tier 2: EFL
const TIER2_COMBOS = [
  { country: "England", names: ["Championship","League One","League Two","EFL Championship","EFL League One","EFL League Two"] },
];

// UEFA izuzetak
const UEFA_PATTERNS = (process.env.UEFA_PATTERNS ||
  "UEFA,Champions League,Europa League,Conference League,UCL,UEL,UECL")
  .split(",").map(s => s.trim()).filter(Boolean);

// Floats overlay
const FLOATS_ENABLED = process.env.SMART45_FLOAT_ENABLED === "1";
const FLOATS_TOPK = parseInt(process.env.SMART45_FLOAT_TOPK || "8", 10);
const CD_GLOBAL = parseInt(process.env.SMART45_FLOAT_COOLDOWN_GLOBAL || "900", 10);
const CD_FIXTURE = parseInt(process.env.SMART45_FLOAT_COOLDOWN_FIXTURE || "1800", 10);

// ---------- helpers ----------
function ymdTZ(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(d);
}
function dayOfWeekTZ(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
  const short = f.format(d).toLowerCase(); // sun, mon, ...
  const map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  return map[short] ?? 0;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function safeStr(x){ try{return String(x||"")}catch{ return ""} }
function maskErr(e){ try{return String(e?.message||e)}catch{ return "unknown"} }

function includesAny(hay, arr){
  const s = safeStr(hay).toLowerCase();
  return arr.some(p => s.includes(p.toLowerCase()));
}

// Upstash unwrap
function unwrapKV(raw) {
  let v = raw;
  try {
    if (typeof v === "string") {
      const p = JSON.parse(v);
      v = (p && typeof p === "object" && "value" in p) ? p.value : p;
    }
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) v = JSON.parse(v);
  } catch {}
  return v;
}
async function kvGet(key) {
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
  } catch { return null; }
}
async function kvSet(key, value, opts = {}) {
  try {
    const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
    if (opts.ex) body.ex = opts.ex;
    if (opts.nx) body.nx = true; // SETNX
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

// ---------- tiering (strict by league+country) ----------
function eqIgnoreCase(a,b){ return safeStr(a).trim().toLowerCase() === safeStr(b).trim().toLowerCase(); }
function countryIs(c, expected){ return safeStr(c).toLowerCase().includes(safeStr(expected).toLowerCase()); }

function isUEFA(leagueName="") { return includesAny(leagueName, UEFA_PATTERNS); }

function isTier1(leagueName="", country="") {
  if (isUEFA(leagueName)) return true;
  const ln = safeStr(leagueName); const c = safeStr(country);
  return TIER1_COMBOS.some(({country:cc, names}) =>
    countryIs(c, cc) && names.some(n => eqIgnoreCase(ln, n))
  );
}
function isTier2(leagueName="", country="") {
  const ln = safeStr(leagueName); const c = safeStr(country);
  return TIER2_COMBOS.some(({country:cc, names}) =>
    countryIs(c, cc) && names.some(n => eqIgnoreCase(ln, n))
  );
}
function getTier(item){
  const ln = safeStr(item?.league?.name);
  const c  = safeStr(item?.league?.country);
  if (isTier1(ln, c)) return 1;
  if (isTier2(ln, c)) return 2;
  return 3;
}

// ---------- hygiene ----------
function passHygiene(item){
  const ln = safeStr(item?.league?.name);
  const hn = safeStr(item?.teams?.home?.name);
  const an = safeStr(item?.teams?.away?.name);
  const banned = ["reserve","reserves"," women "," women","women "," w.","u19","u20","u21","u23"];
  if (includesAny(ln, banned)) return false;
  if (includesAny(hn, banned) || includesAny(an, banned)) return false;
  // Friendlies i II/B timovi su dozvoljeni
  return true;
}

// ---------- Tier3 strict + caps ----------
function passTier3Strict(item){
  const bkc = Number(item?.bookmakers_count ?? 0);
  if (!Number.isFinite(bkc) || bkc < TIER3_MIN_BOOKIES) return false;
  const edgepp = Number(item?.edge_pp ?? item?.edge ?? 0) || 0;
  const ev = Number(item?.ev ?? 0) || 0;
  if (!(edgepp >= TIER3_MIN_EDGE_PP || ev >= TIER3_MIN_EV)) return false;
  if (TIER3_MIN_ODDS > 0) {
    const odds = Number(item?.market_odds ?? 0);
    if (!Number.isFinite(odds) || odds < TIER3_MIN_ODDS) return false;
  }
  return true;
}

function filterWithCapsAndTiers(list, maxPerLeague, tier3MaxTotal){
  const perLeague = new Map();
  let tier3Count = 0;
  const out = [];

  for (const it of list){
    if (!passHygiene(it)) continue;

    const lgId = it?.league?.id;
    const lgName = safeStr(it?.league?.name);
    const country = safeStr(it?.league?.country);
    const uefa = isUEFA(lgName);
    const tier = getTier(it);

    if (tier === 3 && !passTier3Strict(it)) continue;

    if (!uefa && maxPerLeague > 0){
      const cnt = perLeague.get(lgId) || 0;
      if (cnt >= maxPerLeague) continue;
      perLeague.set(lgId, cnt + 1);
    }

    if (tier === 3) {
      if (tier3Count >= tier3MaxTotal) continue;
      tier3Count++;
    }

    out.push(it);
  }
  return out;
}

// ---------- floats overlay ----------
function applyAdjustedConfidence(item, live) {
  const base = typeof item?.confidence_pct === "number" ? item.confidence_pct : null;
  if (base == null) return null;
  let adj = base; const why = [];

  if (typeof live?.movement_pct === "number") {
    if (live.movement_pct >= 1.5) { adj += 1; why.push("+1pp drift ≥ +1.5%"); }
    if (live.movement_pct <= -1.5) { adj -= 1; why.push("-1pp drift ≤ -1.5%"); }
  }
  if (typeof live?.bookmakers_count === "number" && live.bookmakers_count >= 4) {
    try {
      const dt = item?.datetime_local?.starting_at?.date_time;
      if (dt) {
        const start = new Date(dt); const now = new Date();
        const mins = Math.floor((start - now) / 60000);
        if (mins <= 120) { adj += 1; why.push("+1pp KO ≤ 120m & bookies ≥ 4"); }
      }
    } catch {}
  }
  adj = clamp(adj, 38, 65);
  return { confidence_pct: adj, why };
}
function buildLiveFromCurrent(snapshotItem, currentItem) {
  if (!snapshotItem || !currentItem) return null;
  const snapOdds = Number(snapshotItem.market_odds);
  const curOdds  = Number(currentItem.market_odds);
  if (!Number.isFinite(snapOdds) || !Number.isFinite(curOdds)) return null;
  const movement_pct = ((curOdds - snapOdds) / snapOdds) * 100;
  const implied_prob = Number(currentItem.implied_prob ?? (1 / curOdds));
  const ev = Number(currentItem.ev ?? (currentItem.model_prob ? (currentItem.model_prob - (1 / curOdds)) : null));
  return {
    odds: curOdds, implied_prob, ev,
    bookmakers_count: Number(currentItem.bookmakers_count ?? snapshotItem.bookmakers_count ?? 0),
    movement_pct, ts: new Date().toISOString(),
  };
}
async function backgroundRefreshFloats(req, topList) {
  if (!FLOATS_ENABLED || !Array.isArray(topList) || topList.length === 0) return;
  const today = ymdTZ();
  const globalKey = `smart45:float:cooldown:${today}`;
  const setOK = await kvSet(globalKey, "1", { nx: true, ex: CD_GLOBAL });
  if (!setOK) return;
  try {
    const proto = req.headers["x-forwarded-proto"] || (req.headers["x-forwarded-protocol"] || "https");
    const host  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-hostname"] || req.headers.host;
    const base  = `${proto}://${host}`;
    const r = await fetch(`${base}/api/value-bets`, { cache: "no-store" });
    const payload = await r.json().catch(() => ({}));
    const pool = Array.isArray(payload?.value_bets) ? payload.value_bets : (Array.isArray(payload) ? payload : []);
    const byId = new Map(pool.map(x => [x.fixture_id, x]));
    const slice = topList.slice(0, Math.max(1, FLOATS_TOPK));
    for (const it of slice) {
      const fx = it?.fixture_id; if (!fx) continue;
      const fixKey = `smart45:float:fx:${fx}`;
      const lockOK = await kvSet(fixKey, "1", { nx: true, ex: CD_FIXTURE });
      if (!lockOK) continue;
      const cur = byId.get(fx); const live = buildLiveFromCurrent(it, cur);
      if (!live) continue;
      await kvSet(`vb:float:${fx}`, live, { ex: Math.max(2 * 3600, CD_FIXTURE) });
    }
  } catch {}
}

// ---------- main ----------
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const today = ymdTZ();
    const dow = dayOfWeekTZ();
    const vbLimitDynamic = (dow === 0 || dow === 6) ? VB_LIMIT_WEEKEND : VB_LIMIT_WEEKDAY;
    const VB_LIMIT_FINAL = Number.isFinite(vbLimitDynamic) ? vbLimitDynamic : VB_LIMIT_FALLBACK;

    // 1) snapshot
    let snapshot = await kvGet(`vb:day:${today}:last`);
    let source = "locked-cache";

    if (!snapshot || (Array.isArray(snapshot) && snapshot.length === 0) || (snapshot && !snapshot.value_bets)) {
      const revRaw = await kvGet(`vb:day:${today}:rev`);
      const rev = parseInt(typeof revRaw === "number" ? String(revRaw) : (revRaw || "").toString(), 10);
      if (Number.isFinite(rev) && rev > 0) {
        const snap2 = await kvGet(`vb:day:${today}:rev:${rev}`);
        if (snap2 && (Array.isArray(snap2) || snap2.value_bets)) {
          snapshot = snap2; source = "locked-rev";
        }
      }
    }

    if (!snapshot || (!Array.isArray(snapshot) && !Array.isArray(snapshot?.value_bets))) {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
        .formatToParts(new Date()).reduce((a, p) => ((a[p.type] = p.value), a), {});
      const hour = parseInt(parts.hour, 10);
      if (hour >= 10) {
        const cdKey = `vb:ensure:cooldown:${today}`;
        const setOK = await kvSet(cdKey, "1", { nx: true, ex: 8 * 60 });
        if (setOK) {
          const proto = req.headers["x-forwarded-proto"] || (req.headers["x-forwarded-protocol"] || "https");
          const host  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-hostname"] || req.headers.host;
          const base  = `${proto}://${host}`;
          fetch(`${base}/api/cron/rebuild`).catch(() => {});
          return res.status(200).json({ value_bets: [], built_at: new Date().toISOString(), day: today, source: "ensure-started" });
        }
      }
      return res.status(200).json({ value_bets: [], built_at: new Date().toISOString(), day: today, source: "ensure-wait" });
    }

    const listRaw = Array.isArray(snapshot) ? snapshot : (snapshot.value_bets || []);

    // Sort: Tier (1<2<3), pa edge/EV, pa kickoff
    const sorted = [...listRaw].sort((a, b) => {
      const ta = getTier(a), tb = getTier(b);
      if (ta !== tb) return ta - tb;
      const ea = Number(a?.edge_pp ?? a?.edge ?? 0);
      const eb = Number(b?.edge_pp ?? b?.edge ?? 0);
      if (eb !== ea) return eb - ea;
      const da = safeStr(a?.datetime_local?.starting_at?.date_time);
      const db = safeStr(b?.datetime_local?.starting_at?.date_time);
      return da.localeCompare(db);
    });

    // Higijena + cap po ligi (UEFA izuzetak) + Tier3 strict + Tier3 cap
    const filteredCapped = filterWithCapsAndTiers(sorted, VB_MAX_PER_LEAGUE, TIER3_MAX_TOTAL);

    // Dinamičan limit
    let finalList = filteredCapped.slice(0, VB_LIMIT_FINAL);
    if (finalList.length === 0 && listRaw.length > 0) {
      finalList = listRaw.slice(0, VB_LIMIT_FINAL);
      source = "fallback-unfiltered";
    }

    // Overlay floats
    const withOverlay = [];
    for (const it of finalList) {
      const fx = it?.fixture_id;
      let live = null, adjusted = null;
      if (fx) {
        const lv = await kvGet(`vb:float:${fx}`);
        if (lv) { live = lv; adjusted = applyAdjustedConfidence(it, live); }
      }
      withOverlay.push(live ? { ...it, live, adjusted } : it);
    }

    // Pozadinski refresh
    backgroundRefreshFloats(req, finalList).catch(() => {});

    return res.status(200).json({
      value_bets: withOverlay,
      built_at: new Date().toISOString(),
      day: today,
      source,
      meta: {
        limit_applied: VB_LIMIT_FINAL,
        league_cap: VB_MAX_PER_LEAGUE,
        tier3_max_total: TIER3_MAX_TOTAL,
        tier3_min_bookies: TIER3_MIN_BOOKIES,
        tier3_min_edge_pp: TIER3_MIN_EDGE_PP,
        tier3_min_ev: TIER3_MIN_EV,
        tier3_min_odds: TIER3_MIN_ODDS,
        floats_enabled: FLOATS_ENABLED,
      },
    });
  } catch (e) {
    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day: ymdTZ(),
      source: "error",
      error: maskErr(e),
    });
  }
}
