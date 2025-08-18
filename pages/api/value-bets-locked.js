// FILE: pages/api/value-bets-locked.js
// Zaključani dnevni feed sa filtrima, dedupom i auto-insights pozivom.
// Ne menja UI; vraća iste strukture kao ranije.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const VB_LIMIT   = parseInt(process.env.VB_LIMIT || "25", 10);
const LEAGUE_CAP = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const TZ         = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ——— Pragovi (fiksno u kodu; po želji prebaci u ENV kasnije)
const MIN_ODDS_ALL = 1.50;               // tvoja želja: ne ispod 1.50
const MAX_ODDS_1X2 = 3.80;               // realno za match-winner
const MAX_ODDS_BTTS = 4.00;              // izbegni 5.5, 10.0 itd.
const MAX_ODDS_OU   = 4.50;              // isto

// min broj kladionica (T1/2 vs T3)
const MIN_BOOKIES_T12 = 4;
const MIN_BOOKIES_T3  = 6;

// confidence floor po marketu
const FLOOR_1X2 = 52;
const FLOOR_OU  = 55;
const FLOOR_BTTS = 55;
const FLOOR_HTFT = 58;

// ostalo
const ACTIVE_HOURS = { from: 10, to: 22 }; // CET prozor za auto-insights
const REBUILD_COOLDOWN_MIN = parseInt(process.env.LOCKED_REBUILD_CD || "20", 10);

// ——— helpers
function setNoStore(res) { res.setHeader("Cache-Control", "no-store"); }

function ymdTZ(d = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    });
    return fmt.format(d);
  } catch {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), da = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }
}
function hmTZ(d = new Date()) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(d).reduce((a,x)=>((a[x.type]=x.value),a),{});
    return { h: parseInt(p.hour,10), m: parseInt(p.minute,10) };
  } catch { return { h:d.getHours(), m:d.getMinutes() }; }
}

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
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
  } catch { return null; }
}
async function kvSet(key, value, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
    if (opts.ex) body.ex = opts.ex;
    if (opts.nx) body.nx = true;
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

// heuristika Tier3
function isTier3(leagueName = "", country = "") {
  const s = `${country} ${leagueName}`.toLowerCase();
  return (
    s.includes("3.") || s.includes("third") || s.includes("liga 3") ||
    s.includes("division 2") || s.includes("second division") ||
    s.includes("regional") || s.includes("amateur") || s.includes("cup - ")
  );
}
function isExcludedLeagueOrTeam(pick) {
  const ln = String(pick?.league?.name || "").toLowerCase();
  const hn = String(pick?.teams?.home?.name || "").toLowerCase();
  const an = String(pick?.teams?.away?.name || "").toLowerCase();
  const bad = /(women|femenin|femmin|ladies|u19|u20|u21|u23|youth|reserve|res\.?)/i;
  if (bad.test(ln) || bad.test(hn) || bad.test(an)) return true;
  return false;
}
function isUEFA(leagueName="") {
  return /uefa|champions league|europa|conference/i.test(String(leagueName));
}
function categoryOf(p) {
  const m = String(p.market_label || p.market || "");
  if (/btts/i.test(m)) return "BTTS";
  if (/over|under|ou/i.test(m)) return "OU";
  if (/ht-?ft|ht\/ft/i.test(m)) return "HT-FT";
  if (/1x2|match winner/i.test(m)) return "1X2";
  return "OTHER";
}
function isOU25(p) {
  if (categoryOf(p) !== "OU") return false;
  const sel = String(p?.selection || "");
  return /(^|\s)(over|under)\s*2\.5\b/i.test(sel);
}
function oddsInRange(p) {
  const cat = categoryOf(p);
  const v = Number(p?.market_odds || 0);
  if (!Number.isFinite(v) || v < MIN_ODDS_ALL) return false;
  if (cat === "1X2")   return v <= MAX_ODDS_1X2;
  if (cat === "BTTS")  return v <= MAX_ODDS_BTTS;
  if (cat === "OU")    return v <= MAX_ODDS_OU;
  if (cat === "HT-FT") return v <= 15; // samo sanity; retko koristimo
  return true;
}
function meetsConfidenceFloor(p) {
  const cat = categoryOf(p);
  const c = Number(p?.confidence_pct || Math.round((p?.model_prob || 0) * 100));
  if (!Number.isFinite(c)) return false;
  if (cat === "1X2")   return c >= FLOOR_1X2;
  if (cat === "BTTS")  return c >= FLOOR_BTTS;
  if (cat === "OU")    return c >= FLOOR_OU;
  if (cat === "HT-FT") return c >= FLOOR_HTFT;
  return false;
}
function minBookiesOK(p, tier3) {
  const n = Number(p?.bookmakers_count || 0);
  return n >= (tier3 ? MIN_BOOKIES_T3 : MIN_BOOKIES_T12);
}
function scorePick(p) {
  const c = Number(p?.confidence_pct || Math.round((p?.model_prob || 0) * 100)) || 0;
  const ev = Number.isFinite(p?.ev) ? p.ev : 0;
  const t = Number(new Date(String(p?.datetime_local?.starting_at?.date_time || "").replace(" ", "T")).getTime());
  // veći c bolji; veći ev bolji; skoriji kickoff bolji
  return c*10000 + ev*100 - (Number.isFinite(t) ? (t/1e7) : 0);
}

// uči mala pomeranja confidence-a (ako postoje u KV)
function applyLearningOverlay(p, tier3, learn) {
  if (!learn || typeof learn !== "object") return p;
  const cat = categoryOf(p);
  const biasGlobal = Number(learn?.global_pp || 0);
  const biasTier3  = Number(learn?.tier3_pp || 0);
  const biasByCat  = Number(learn?.[`cat_${cat}_pp`] || 0);
  const base = Number(p?.confidence_pct || Math.round((p?.model_prob || 0) * 100)) || 0;
  let adj = base + biasGlobal + (tier3 ? biasTier3 : 0) + biasByCat;
  if (adj < 0) adj = 0;
  if (adj > 100) adj = 100;
  return { ...p, confidence_pct: adj };
}

// učitaj 2-linijski “Zašto” iz KV
async function fetchInsightLine(fid) {
  const key = `vb:insight:${fid}`;
  const obj = unwrapKV(await kvGet(key));
  return (obj && obj.line) ? String(obj.line) : null;
}

export default async function handler(req, res) {
  setNoStore(res);

  const day  = ymdTZ();
  const { h } = hmTZ();

  const lastKey = `vb:day:${day}:last`;
  const revKey  = `vb:day:${day}:rev`;

  let arr = unwrapKV(await kvGet(lastKey));
  if (!Array.isArray(arr)) arr = [];

  // Ako nema snimka, vrati "ensure-wait" (isto ponašanje kao ranije)
  if (!arr.length) {
    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day,
      source: "ensure-wait",
      meta: { limit_applied: VB_LIMIT, league_cap: LEAGUE_CAP }
    });
  }

  // Auto-insights: jednom dnevno, u aktivnim satima, tiho okini /api/insights-build
  if (h >= ACTIVE_HOURS.from && h <= ACTIVE_HOURS.to) {
    const doneKey = `vb:insights:done:${day}`;
    const done = await kvGet(doneKey);
    if (!done) {
      try {
        const proto = req.headers["x-forwarded-proto"] || "https";
        const host  = req.headers["x-forwarded-host"] || req.headers.host;
        const base  = `${proto}://${host}`;
        // fire & forget
        fetch(`${base}/api/insights-build`, { cache: "no-store" }).catch(()=>{});
        await kvSet(doneKey, { ts: Date.now() }, { ex: 6*3600 });
      } catch {}
    }
  }

  // Učitamo (ako postoji) learn overlay
  const learn = unwrapKV(await kvGet("vb:learn:calib:latest"));

  // ——— Filtriranje, cap po ligi, dedup po meču
  const byLeagueCount = new Map();
  const bestByFixture = new Map(); // fixture_id -> najbolji pick

  for (const p of arr) {
    const fid = p?.fixture_id;
    if (!fid) continue;

    if (isExcludedLeagueOrTeam(p)) continue;

    const leagueName = p?.league?.name || "";
    const leagueKey = `${p?.league?.country || ""}::${leagueName}`;
    const isUefa = isUEFA(leagueName);
    const cap = isUefa ? Math.max(LEAGUE_CAP, 4) : LEAGUE_CAP;

    const current = byLeagueCount.get(leagueKey) || 0;
    if (current >= cap) continue;

    const tier3 = isTier3(leagueName, p?.league?.country || "");
    const cat   = categoryOf(p);

    // market-spec filteri
    if (cat === "OU" && !isOU25(p)) continue;         // samo linija 2.5
    if (!oddsInRange(p)) continue;                     // min 1.50 + max po marketu
    if (!meetsConfidenceFloor(p)) continue;            // floor po marketu
    if (!minBookiesOK(p, tier3)) continue;             // minimalan broj kladionica

    // learning overlay (ako postoji)
    const withLearn = applyLearningOverlay(p, tier3, learn);

    // kandiduj za "najbolji po meču"
    const prev = bestByFixture.get(fid);
    if (!prev || scorePick(withLearn) > scorePick(prev)) {
      bestByFixture.set(fid, withLearn);
    }
  }

  // spoji po ligama i limit
  const out = [];
  for (const pick of bestByFixture.values()) {
    if (out.length >= VB_LIMIT) break;

    const leagueName = pick?.league?.name || "";
    const leagueKey  = `${pick?.league?.country || ""}::${leagueName}`;
    const isUefa = isUEFA(leagueName);
    const cap = isUefa ? Math.max(LEAGUE_CAP, 4) : LEAGUE_CAP;

    const cur = byLeagueCount.get(leagueKey) || 0;
    if (cur >= cap) continue;

    byLeagueCount.set(leagueKey, cur + 1);
    out.push(pick);
  }

  // opcioni ?top=N
  const topN = Math.max(0, parseInt(String(req.query?.top || "0"), 10) || 0);
  const limited = topN > 0 ? out.slice(0, topN) : out;

  // ubaci 2-linijski “Zašto” gde postoji (KV insights)
  // (radimo graceful: ako nema, ostaje originalni summary)
  await Promise.all(limited.map(async (p) => {
    try {
      const line = await fetchInsightLine(p.fixture_id);
      if (line) {
        // zadrži bullets, ali zameni summary jasnim tekstom (sa novim redom)
        p.explain = { ...(p.explain||{}), summary: line };
      }
    } catch {}
  }));

  // rev info (ako postoji)
  const revRaw = unwrapKV(await kvGet(revKey));
  let rev = 0; try { rev = parseInt(String(revRaw?.value ?? revRaw ?? "0"), 10) || 0; } catch {}

  return res.status(200).json({
    value_bets: limited,
    built_at: new Date().toISOString(),
    day,
    source: "locked-cache",
    meta: {
      limit_applied: VB_LIMIT,
      league_cap: LEAGUE_CAP,
      min_odds_all: MIN_ODDS_ALL,
      max_odds: { "1X2": MAX_ODDS_1X2, BTTS: MAX_ODDS_BTTS, OU: MAX_ODDS_OU },
      min_bookies: { t12: MIN_BOOKIES_T12, t3: MIN_BOOKIES_T3 },
      floors: { "1X2": FLOOR_1X2, OU: FLOOR_OU, BTTS: FLOOR_BTTS, "HT-FT": FLOOR_HTFT },
      auto_insights: true,
      rev
    },
  });
}
