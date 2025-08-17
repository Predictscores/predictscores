// =============================================
// Locked snapshot + Smart overlay (floats), tiering (league+country),
// caps, SAFE-prioritet, dynamic limit, i "auto-rebuild on first refresh"
// =============================================

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// VB limit (vikend/radni dan) i cap-ovi
const VB_LIMIT_FALLBACK = parseInt(process.env.VB_LIMIT || "25", 10);
const VB_LIMIT_WEEKDAY = parseInt(process.env.VB_LIMIT_WEEKDAY || "15", 10);
const VB_LIMIT_WEEKEND = parseInt(process.env.VB_LIMIT_WEEKEND || "25", 10);
const VB_MAX_PER_LEAGUE = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);

// Tier 3 pooštren filter
const TIER3_MAX_TOTAL = parseInt(process.env.TIER3_MAX_TOTAL || "6", 10);
const TIER3_MIN_BOOKIES = parseInt(process.env.TIER3_MIN_BOOKIES || "4", 10);
const TIER3_MIN_EDGE_PP = parseFloat(process.env.TIER3_MIN_EDGE_PP || "8");
const TIER3_MIN_EV = parseFloat(process.env.TIER3_MIN_EV || "0.08");
const TIER3_MIN_ODDS = parseFloat(process.env.TIER3_MIN_ODDS || "0"); // 0 = off

// SAFE prioritet (default uključeno, bez ENV obavezno)
const VB_SAFE_ENABLED = (process.env.VB_SAFE_ENABLED ?? "1") === "1";
const SAFE_MIN_PROB = parseFloat(process.env.SAFE_MIN_PROB || "0.65");   // 65%
const SAFE_MIN_ODDS = parseFloat(process.env.SAFE_MIN_ODDS || "1.50");   // kvota >= 1.50
const SAFE_MIN_EV   = parseFloat(process.env.SAFE_MIN_EV   || "-0.005"); // dozvoli do -0.5% EV
const SAFE_MIN_BOOKIES_T12 = parseInt(process.env.SAFE_MIN_BOOKIES_T12 || "4", 10);
const SAFE_MIN_BOOKIES_T3  = parseInt(process.env.SAFE_MIN_BOOKIES_T3  || "5", 10);

// Auto-rebuild na prvom refreshu (bez Cron-a)
const LOCKED_STALE_MIN   = parseInt(process.env.LOCKED_STALE_MIN || "60", 10); // minute
const LOCKED_REBUILD_CD  = parseInt(process.env.LOCKED_REBUILD_CD || "20", 10); // minute
const LOCKED_ACTIVE_HOURS = process.env.LOCKED_ACTIVE_HOURS || "10-22"; // CET

// UEFA izuzetak
const UEFA_PATTERNS = (process.env.UEFA_PATTERNS ||
  "UEFA,Champions League,Europa League,Conference League,UCL,UEL,UECL")
  .split(",").map(s => s.trim()).filter(Boolean);

// Tier 1 (bez MLS-a) i Tier 2 (EFL) — striktno po (league,country)
const TIER1_COMBOS = [
  { country: "England",     names: ["Premier League"] },
  { country: "Spain",       names: ["La Liga"] },
  { country: "Germany",     names: ["Bundesliga"] },
  { country: "Italy",       names: ["Serie A"] },
  { country: "France",      names: ["Ligue 1"] },
  { country: "Serbia",      names: ["SuperLiga","Super Liga"] },
  { country: "Netherlands", names: ["Eredivisie"] },
];
const TIER2_COMBOS = [
  { country: "England", names: ["Championship","League One","League Two","EFL Championship","EFL League One","EFL League Two"] },
];

// Floats overlay (SMART45) — ti si već uključio SMART45_FLOAT_ENABLED=1
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
  const short = f.format(d).toLowerCase();
  const map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  return map[short] ?? 0;
}
function hourTZ(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false });
  return parseInt(f.format(d), 10);
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function safeStr(x){ try{return String(x||"")}catch{ return ""} }
function includesAny(hay, arr){
  const s = safeStr(hay).toLowerCase();
  return arr.some(p => s.includes(p.toLowerCase()));
}
function eqIgnoreCase(a,b){ return safeStr(a).trim().toLowerCase() === safeStr(b).trim().toLowerCase(); }
function countryIs(c, expected){ return safeStr(c).toLowerCase().includes(safeStr(expected).toLowerCase()); }
function maskErr(e){ try{return String(e?.message||e)}catch{ return "unknown"} }

function parseActiveHours(str) {
  // "10-22" -> {start:10, end:22}
  const m = safeStr(str).match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return { start: 10, end: 22 };
  return { start: Math.min(23, parseInt(m[1],10)), end: Math.min(23, parseInt(m[2],10)) };
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

// ---------- SAFE prioritet (samo 1X2, iz postojećeg snapshot-a) ----------
function isSafePick(item){
  if (!VB_SAFE_ENABLED) return false;
  if (safeStr(item?.market) !== "1X2") return false;
  const tier = getTier(item);
  const prob = Number(item?.model_prob ?? 0);      // 0.00 - 1.00
  const odds = Number(item?.market_odds ?? 0);
  const ev   = Number(item?.ev ?? 0);
  const bkc  = Number(item?.bookmakers_count ?? 0);
  if (!Number.isFinite(prob) || !Number.isFinite(odds) || !Number.isFinite(ev)) return false;
  if (prob < SAFE_MIN_PROB) return false;
  if (odds < SAFE_MIN_ODDS) return false;
  if (ev < SAFE_MIN_EV) return false;
  const minBk = (tier === 3 ? SAFE_MIN_BOOKIES_T3 : SAFE_MIN_BOOKIES_T12);
  if (!Number.isFinite(bkc) || bkc < minBk) return false;
  return true;
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

// ---------- auto-rebuild on first refresh ----------
async function maybeAutoRebuild(req, today) {
  // cilj: bez Cron-a, u aktivnim satima, sa cooldown-om
  const { start, end } = parseActiveHours(LOCKED_ACTIVE_HOURS);
  const h = hourTZ();
  const inWindow = h >= start && h <= end;

  if (!inWindow) return false;

  // Hladan throttle: jednom na LOCKED_REBUILD_CD minuta
  const cdKey = `vb:auto:rebuild:cd:${today}`;
  const cdOK = await kvSet(cdKey, "1", { nx: true, ex: LOCKED_REBUILD_CD * 60 });
  if (!cdOK) return false;

  // Opcioni "stale" signal: ako postoji meta vreme — koristi; ako ne postoji — samo pusti rebuild sa cooldown-om
  // (Generator možda ne zapisuje built_at u KV; zato je fallback da ne "guši" prečesto.)
  try {
    const proto = req.headers["x-forwarded-proto"] || (req.headers["x-forwarded-protocol"] || "https");
    const host  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-hostname"] || req.headers.host;
    const base  = `${proto}://${host}`;
    fetch(`${base}/api/cron/rebuild`).catch(() => {});
    return true;
  } catch { return false; }
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

    // 1a) fallback preko rev pointera
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

    // 1b) self-heal ako nema snapshot-a posle 10h
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

    // 2) lista iz snapshot-a
    const listRaw = Array.isArray(snapshot) ? snapshot : (snapshot.value_bets || []);

    // 2a) Sort sa SAFE prioritetom:
    //  - SAFE pre ostalih
    //  - zatim Tier (1 < 2 < 3)
    //  - zatim edge/EV
    //  - zatim kickoff
    const sorted = [...listRaw].sort((a, b) => {
      const sa = isSafePick(a), sb = isSafePick(b);
      if (sa !== sb) return sa ? -1 : 1;

      const ta = getTier(a), tb = getTier(b);
      if (ta !== tb) return ta - tb;

      // unutar SAFE grupe blago favorizuj veći model_prob, zatim viši EV
      if (sa && sb) {
        const pa = Number(a?.model_prob ?? 0), pb = Number(b?.model_prob ?? 0);
        if (pb !== pa) return pb - pa;
      }
      const ea = Number(a?.edge_pp ?? a?.edge ?? 0);
      const eb = Number(b?.edge_pp ?? b?.edge ?? 0);
      if (eb !== ea) return eb - ea;

      const da = safeStr(a?.datetime_local?.starting_at?.date_time);
      const db = safeStr(b?.datetime_local?.starting_at?.date_time);
      return da.localeCompare(db);
    });

    // 2b) Higijena + cap po ligi (UEFA izuzetak) + Tier3 strict + Tier3 cap total
    const filteredCapped = filterWithCapsAndTiers(sorted, VB_MAX_PER_LEAGUE, TIER3_MAX_TOTAL);

    // 2c) Dinamičan limit
    let finalList = filteredCapped.slice(0, VB_LIMIT_FINAL);

    // 2d) Fail-safe ako sve odsečemo
    if (finalList.length === 0 && listRaw.length > 0) {
      finalList = listRaw.slice(0, VB_LIMIT_FINAL);
      source = "fallback-unfiltered";
    }

    // 3) Overlay floats (ne menja poredak)
    const withOverlay = [];
    for (const it of finalList) {
      const fx = it?.fixture_id;
      let live = null, adjusted = null, safe_flag = undefined;
      if (fx) {
        const lv = await kvGet(`vb:float:${fx}`);
        if (lv) { live = lv; adjusted = applyAdjustedConfidence(it, live); }
      }
      if (VB_SAFE_ENABLED) safe_flag = isSafePick(it);
      const out = live ? { ...it, live, adjusted } : { ...it };
      if (typeof safe_flag === "boolean") out.safe = safe_flag;
      withOverlay.push(out);
    }

    // 4) Pozadinski refresh floats za TOPK (ne blokira)
    backgroundRefreshFloats(req, finalList).catch(() => {});

    // 5) Auto-rebuild on first refresh (bez čekanja)
    maybeAutoRebuild(req, today).catch(() => {});

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
        safe_enabled: VB_SAFE_ENABLED,
        safe_min_prob: SAFE_MIN_PROB,
        safe_min_odds: SAFE_MIN_ODDS,
        safe_min_ev: SAFE_MIN_EV,
        safe_min_bookies_t12: SAFE_MIN_BOOKIES_T12,
        safe_min_bookies_t3: SAFE_MIN_BOOKIES_T3,
        auto_rebuild: {
          active_hours: LOCKED_ACTIVE_HOURS,
          stale_min: LOCKED_STALE_MIN,
          rebuild_cooldown_min: LOCKED_REBUILD_CD,
        },
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
