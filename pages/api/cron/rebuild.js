// pages/api/cron/rebuild.js
// Slot rebuild (15/25 po slotu), objedinjeno biranje NAJBOLJEG predloga po utakmici
// preko 4 tržišta: 1X2, BTTS, OU 2.5, HT-FT.
//
// Ispravke u ovoj verziji:
// - BTTS i OU 2.5: kandidat nastaje SAMO ako tržište ima OBE strane (Yes & No / Over & Under)
//   sa validnim median cenama i dovoljno knjiga na OBE strane; nema više “jednostranih” 100% confidence.
// - HT-FT: kandidat nastaje samo ako postoji minimalan broj validnih kombinacija (≥3 strict / ≥2 relaxed).
// - Best-of-market po fixture-u ostaje: max confidence (tie-break EV). Globalno rangiranje po EV.
// - Two-pass: ako strogi pass ne vrati ništa, radi se relaxed pass na već učitanim payload-ima (bez dodatnih poziva).
//
// UI ne diramo. Upisuje vbl:<YMD>:<slot> i vbl_full:<YMD>:<slot> + kompatibilne alias ključeve.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    const y = d.getUTCFullYear(),
      m = String(d.getUTCMonth() + 1).padStart(2, "0"),
      dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}
function toLocal(dateIso, tz = TZ) {
  try {
    const d = new Date(dateIso);
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return {
      ymd: `${p.year}-${p.month}-${p.day}`,
      hm: `${p.hour}:${p.minute}`,
      hour: Number(p.hour),
      local: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
    };
  } catch {
    return { ymd: ymdInTZ(new Date(), tz), hm: "00:00", hour: 0, local: "" };
  }
}
function slotOfHour(h) { return h < 10 ? "late" : (h < 15 ? "am" : "pm"); }
function windowForSlot(slot) {
  if (slot === "late") return { hmin: 0, hmax: 9, label: "late" };
  if (slot === "am") return { hmin: 10, hmax: 14, label: "am" };
  return { hmin: 15, hmax: 23, label: "pm" };
}
function isWeekend(d = new Date(), tz = TZ) {
  try {
    const wd = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d).toLowerCase();
    return wd.startsWith("sat") || wd.startsWith("sun");
  } catch {
    const wd = d.getUTCDay();
    return wd === 0 || wd === 6;
  }
}
function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function envBool(name, def=false){
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function envList(nameA, nameB) {
  const raw = process.env[nameA] || process.env[nameB] || "";
  return String(raw)
    .split(/[,;|\n]/g)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

// limiti po danu/slotu
const DEFAULT_LIMIT_WEEKDAY = envNum("SLOT_WEEKDAY_LIMIT", 15);
const DEFAULT_LIMIT_WEEKEND = envNum("SLOT_WEEKEND_LIMIT", 25);
const LIMIT_LATE_WEEKDAY = envNum("SLOT_LATE_WEEKDAY_LIMIT", DEFAULT_LIMIT_WEEKDAY);
const VB_LIMIT = envNum("VB_LIMIT", 0); // 0 = no extra cap

// filter/guardrails (ugrađene default vrednosti)
const MIN_ODDS = envNum("MIN_ODDS", 1.01);
const MODEL_ALPHA = envNum("MODEL_ALPHA", 0.4);
const EXCLUDE_WOMEN = envBool("EXCLUDE_WOMEN", true);
const TRUSTED_ONLY = envBool("ODDS_TRUSTED_ONLY", false);
const TRUSTED_LIST = envList("TRUSTED_BOOKMAKERS", "TRUSTED_BOOKIES");

// kvalitet selekcije (default pravila u kodu)
const MIN_BOOKS_PER_SEL = 3;     // minimalno nezavisnih knjiga na izabranoj selekciji
const EV_FLOOR = 0.02;           // minimalni EV za ulaz u listu (2%)
const SPREAD_STRICT = 0.25;      // spread (mx/mn - 1) u okviru jedne selekcije (strogo)
const SPREAD_LOOSE  = 0.40;      // spread (opušteno) za fallback pass

// minimalna “punina” HT-FT tržišta (broj validnih kombinacija sa dovoljnim books/spread-om)
const HTFT_MIN_COMBOS_STRICT = 3;
const HTFT_MIN_COMBOS_RELAX  = 2;

// API-Football
const API_BASE = process.env.API_FOOTBALL_BASE_URL || process.env.API_FOOTBALL || "https://v3.football.api-sports.io";
const API_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "";
function afHeaders() {
  const h = {};
  if (API_KEY) {
    h["x-apisports-key"] = API_KEY;
    h["x-rapidapi-key"] = API_KEY;
  }
  return h;
}
async function getJSON(url) {
  const r = await fetch(url, { headers: afHeaders() });
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) throw new Error(`AF ${r.status} ${await r.text().catch(() => r.statusText)}`);
  return ct.includes("application/json") ? await r.json() : JSON.parse(await r.text());
}
async function fetchFixturesByDate(ymd) {
  if (!API_KEY) return [];
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/, "")}/fixtures?date=${encodeURIComponent(ymd)}`);
    return Array.isArray(j?.response) ? j.response : [];
  } catch { return []; }
}
async function fetchOddsForFixture(fixtureId) {
  if (!API_KEY) return [];
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/, "")}/odds?fixture=${encodeURIComponent(fixtureId)}`);
    return Array.isArray(j?.response) ? j.response : [];
  } catch { return []; }
}
async function fetchPredictionForFixture(fixtureId) {
  if (!API_KEY) return null;
  try {
    const j = await getJSON(`${API_BASE.replace(/\/+$/, "")}/predictions?fixture=${encodeURIComponent(fixtureId)}`);
    const arr = Array.isArray(j?.response) ? j.response : [];
    return arr[0] || null;
  } catch { return null; }
}

// helpers
function median(a) {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!x.length) return NaN;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function trimmedMedian(a) {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (x.length >= 5) { x.shift(); x.pop(); }
  if (!x.length) return NaN;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function uniqueName(row) {
  return String(row?.name ?? row?.bookmaker?.name ?? row?.id ?? row?.bookmaker ?? "").toLowerCase();
}
function isTrustedBook(name) {
  if (!TRUSTED_ONLY) return true;
  if (!TRUSTED_LIST.length) return true;
  const n = String(name || "").toLowerCase().trim();
  return TRUSTED_LIST.some(t => n.includes(t));
}
function extractRows(oddsPayload) {
  const roots = Array.isArray(oddsPayload) ? oddsPayload : [];
  const rows = [];
  for (const root of roots) {
    if (!root) continue;
    if (Array.isArray(root.bookmakers)) { for (const bk of root.bookmakers) rows.push(bk); continue; }
    if (Array.isArray(root.bets)) { rows.push(root); continue; }
    if (root.bookmaker && Array.isArray(root.bookmaker.bets)) { rows.push(root.bookmaker); continue; }
  }
  return rows;
}
function spreadOf(arr) {
  const a = arr.filter(Number.isFinite);
  if (a.length < 2) return 0;
  const mx = Math.max(...a), mn = Math.min(...a);
  if (!(mx > 0 && mn > 0)) return 0;
  return (mx / mn) - 1;
}

// --- market extractors (vraćaju {pricesBy, countsBy, medBy, spreadBy})
function extract1X2(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const by = { "1": [], "X": [], "2": [] };
  const seen = { "1": new Set(), "X": new Set(), "2": new Set() };
  for (const row of rows) {
    const bkm = uniqueName(row);
    if (!isTrustedBook(bkm)) continue;
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets) {
      const nm = (bet?.name || "").toLowerCase();
      if (!/match\s*winner|^1x2$|(^|\s)winner(\s|$)/i.test(nm)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const lab = (v?.value || v?.label || "").toString().toLowerCase();
        let code = null;
        if (lab === "1" || /^home/.test(lab)) code = "1";
        else if (lab === "x" || /^draw/.test(lab)) code = "X";
        else if (lab === "2" || /^away/.test(lab)) code = "2";
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        by[code].push(price);
        seen[code].add(bkm);
      }
    }
  }
  const medBy = { "1": trimmedMedian(by["1"]), "X": trimmedMedian(by["X"]), "2": trimmedMedian(by["2"]) };
  const countsBy = { "1": seen["1"].size, "X": seen["X"].size, "2": seen["2"].size };
  const spreadBy = { "1": spreadOf(by["1"]), "X": spreadOf(by["X"]), "2": spreadOf(by["2"]) };
  return { by, medBy, countsBy, spreadBy };
}

function extractBTTS(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const by = { Y: [], N: [] }, seen = { Y: new Set(), N: new Set() };
  for (const row of rows) {
    const bkm = uniqueName(row);
    if (!isTrustedBook(bkm)) continue;
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets) {
      const nm = (bet?.name || "").toLowerCase();
      if (!/both\s*teams\s*to\s*score|btts/i.test(nm)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const lab = (v?.value || v?.label || "").toString().toLowerCase();
        const code = lab.includes("yes") ? "Y" : lab.includes("no") ? "N" : null;
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        by[code].push(price);
        seen[code].add(bkm);
      }
    }
  }
  const medBy = { Y: trimmedMedian(by.Y), N: trimmedMedian(by.N) };
  const countsBy = { Y: seen.Y.size, N: seen.N.size };
  const spreadBy = { Y: spreadOf(by.Y), N: spreadOf(by.N) };
  return { by, medBy, countsBy, spreadBy };
}

function extractOU25(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const by = { O: [], U: [] }, seen = { O: new Set(), U: new Set() };
  for (const row of rows) {
    const bkm = uniqueName(row);
    if (!isTrustedBook(bkm)) continue;
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets) {
      const nm = (bet?.name || "").toLowerCase();
      if (!/over\/under|goals\s*over\/under|total\s*goals/i.test(nm)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const lab = (v?.value || v?.label || "").toString().toLowerCase();
        if (!/2\.5/.test(lab)) continue;
        const code = lab.includes("over") ? "O" : lab.includes("under") ? "U" : null;
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        by[code].push(price);
        seen[code].add(bkm);
      }
    }
  }
  const medBy = { O: trimmedMedian(by.O), U: trimmedMedian(by.U) };
  const countsBy = { O: seen.O.size, U: seen.U.size };
  const spreadBy = { O: spreadOf(by.O), U: spreadOf(by.U) };
  return { by, medBy, countsBy, spreadBy };
}

function extractHTFT(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const keys = ["HH","HD","HA","DH","DD","DA","AH","AD","AA"];
  const by = Object.fromEntries(keys.map(k => [k, []]));
  const seen = Object.fromEntries(keys.map(k => [k, new Set()]));
  for (const row of rows) {
    const bkm = uniqueName(row);
    if (!isTrustedBook(bkm)) continue;
    const bets = Array.isArray(row?.bets) ? row.bets : [];
    for (const bet of bets) {
      const nm = (bet?.name || "").toLowerCase();
      if (!/half\s*time.*full\s*time|ht\s*\/\s*ft|ht-?ft/i.test(nm)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const label = (v?.value || v?.label || "").toString().toLowerCase().replace(/\s+/g, "");
        let code = null;
        if (/^home\/home|^hh$/.test(label)) code = "HH";
        else if (/^home\/draw|^hd$/.test(label)) code = "HD";
        else if (/^home\/away|^ha$/.test(label)) code = "HA";
        else if (/^draw\/home|^dh$/.test(label)) code = "DH";
        else if (/^draw\/draw|^dd$/.test(label)) code = "DD";
        else if (/^draw\/away|^da$/.test(label)) code = "DA";
        else if (/^away\/home|^ah$/.test(label)) code = "AH";
        else if (/^away\/draw|^ad$/.test(label)) code = "AD";
        else if (/^away\/away|^aa$/.test(label)) code = "AA";
        if (!code) continue;
        const price = Number(v?.odd ?? v?.price ?? v?.odds);
        if (!Number.isFinite(price) || price < MIN_ODDS) continue;
        by[code].push(price);
        seen[code].add(bkm);
      }
    }
  }
  const medBy = Object.fromEntries(Object.keys(by).map(k => [k, trimmedMedian(by[k])]));
  const countsBy = Object.fromEntries(Object.keys(by).map(k => [k, seen[k].size]));
  const spreadBy = Object.fromEntries(Object.keys(by).map(k => [k, spreadOf(by[k])]));
  return { by, medBy, countsBy, spreadBy };
}

function norm3(a,b,c){
  const s = (a||0)+(b||0)+(c||0);
  if (s<=0) return {A:null,B:null,C:null};
  return {A:(a||0)/s,B:(b||0)/s,C:(c||0)/s};
}
function pickLabel1X2(code){ return code==="1"?"Home":(code==="2"?"Away":"Draw"); }

function dynamicUpliftCap(selBooksCount, selSpread){
  // dublje tržište → stroži cap; plitko → nešto veći cap, ali ga smanjuj kad je spread visok
  let base = selBooksCount>=8 ? 0.03 : (selBooksCount>=5 ? 0.04 : 0.05);
  if (selSpread > 0.30) base *= 0.6;
  else if (selSpread > 0.20) base *= 0.8;
  return base;
}

function womenMention(s=""){
  if (/\b(women|women's|ladies)\b/i.test(s)) return true;
  if (/\b(femenina|feminine|feminin|femminile)\b/i.test(s)) return true;
  if (/\b(dames|dam|kvinner|kvinn|kvinnor)\b/i.test(s)) return true;
  if (/\(w\)/i.test(s)) return true;
  if (/\sW$/i.test(s)) return true;
  if (/女子|여자/.test(s)) return true;
  return false;
}
function isWomensLeague(leagueName = "", teams = { home: "", away: "" }) {
  return EXCLUDE_WOMEN ? (womenMention(leagueName) || womenMention(teams.home) || womenMention(teams.away)) : false;
}

// KV
async function kvSetJSON_safe(key, value, ttlSec = null) {
  const base = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("KV REST env not set");
  const urlA = ttlSec!=null
    ? `${base.replace(/\/+$/, "")}/setex/${encodeURIComponent(key)}/${ttlSec}`
    : `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}`;
  let r = await fetch(urlA, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(value)
  }).catch(()=>null);
  if (r && r.ok) return true;

  const urlB = ttlSec!=null
    ? `${base.replace(/\/+$/, "")}/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(JSON.stringify(value))}`
    : `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  r = await fetch(urlB, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(()=>null);
  if (r && r.ok) return true;

  const msg = r ? await r.text().catch(()=>String(r.status)) : "network-error";
  throw new Error(`KV set failed: ${msg.slice(0,200)}`);
}

// evaluacija kandidata po tržištu za jedan fixture
function buildCandidate(recBase, market, code, label, price, prob, booksCount) {
  if (!Number.isFinite(price) || price < MIN_ODDS) return null;
  if (!Number.isFinite(prob)) return null;
  if (!Number.isFinite(booksCount) || booksCount < MIN_BOOKS_PER_SEL) return null;

  const confidence_pct = Math.round(Math.max(0, Math.min(100, prob*100)));
  const _implied = Number((1/price).toFixed(4));
  const _ev = Number((price*prob - 1).toFixed(12));

  if (!Number.isFinite(_ev) || _ev < EV_FLOOR) return null;

  return {
    fixture_id: recBase.fixture_id,
    market, pick: label, pick_code: code, selection_label: label,
    model_prob: Number(prob.toFixed(4)),
    confidence_pct,
    odds: { price: Number(price), books_count: booksCount },
    league: recBase.league, league_name: recBase.league_name, league_country: recBase.league_country,
    teams: recBase.teams, home: recBase.home, away: recBase.away,
    kickoff: recBase.kickoff, kickoff_utc: recBase.kickoff_utc,
    _implied, _ev,
  };
}

export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const slotQ = (req.query.slot && String(req.query.slot)) || slotOfHour(toLocal(now, TZ).hour);
    const slotWin = windowForSlot(slotQ);
    const isWknd = isWeekend(now, TZ);
    let slotLimit = slotQ === "late"
      ? (isWknd ? DEFAULT_LIMIT_WEEKEND : LIMIT_LATE_WEEKDAY)
      : (isWknd ? DEFAULT_LIMIT_WEEKEND : DEFAULT_LIMIT_WEEKDAY);
    if (VB_LIMIT > 0) slotLimit = Math.min(slotLimit, VB_LIMIT);

    const wantDebug = String(req.query.debug||"") === "1";
    const debug = { ymd, slot: slotQ };

    // 1) fixtures u slotu
    const raw = await fetchFixturesByDate(ymd);
    debug.fixtures_total = Array.isArray(raw) ? raw.length : 0;

    let fixtures = (Array.isArray(raw) ? raw : [])
      .map((r) => {
        const fx = r?.fixture || {};
        const lg = r?.league || {};
        const tm = r?.teams || {};
        const loc = toLocal(fx?.date, TZ);
        const home = tm?.home?.name || tm?.home || "";
        const away = tm?.away?.name || tm?.away || "";
        return {
          fixture_id: fx?.id,
          date_utc: fx?.date,
          local_hour: loc.hour,
          local_str: `${loc.ymd} ${loc.hm}`,
          league: { id: lg?.id, name: lg?.name, country: lg?.country },
          teams: { home, away }
        };
      })
      .filter(fx => fx.fixture_id && fx.date_utc != null);

    debug.after_basic = fixtures.length;

    fixtures = fixtures.filter(fx => fx.local_hour >= slotWin.hmin && fx.local_hour <= slotWin.hmax);
    debug.after_slot = fixtures.length;

    fixtures = fixtures.filter(fx => !isWomensLeague(fx.league?.name, fx.teams));
    debug.after_gender_filter = fixtures.length;

    // cap kandidata radi troška (3x limit je obično dosta)
    const considered = Math.min(fixtures.length, Math.max(slotLimit*3, slotLimit+10));
    fixtures = fixtures.slice(0, considered);
    debug.considered = fixtures.length;

    const bestPerFixture_strict = [];
    const bestPerFixture_relaxed = [];
    const dropStats = { noOdds:0, noPick:0, ok:0 };

    for (const fx of fixtures) {
      // payloadi (jednom po fixture-u)
      const oddsPayload = await fetchOddsForFixture(fx.fixture_id);
      const oddsArr = Array.isArray(oddsPayload) ? oddsPayload : [];
      if (!oddsArr.length){ dropStats.noOdds++; continue; }

      const pred = await fetchPredictionForFixture(fx.fixture_id).catch(()=>null);
      const comp = pred?.predictions || pred?.prediction || pred || {};
      const pHome = Number(String(comp?.percent?.home || comp?.home_percent || "").replace("%",""));
      const pDraw = Number(String(comp?.percent?.draw || comp?.draw_percent || "").replace("%",""));
      const pAway = Number(String(comp?.percent?.away || comp?.away_percent || "").replace("%",""));

      const recBase = {
        fixture_id: fx.fixture_id,
        league: fx.league, league_name: fx.league?.name||"", league_country: fx.league?.country||"",
        teams: fx.teams, home: fx.teams.home, away: fx.teams.away,
        kickoff: fx.local_str, kickoff_utc: fx.date_utc
      };

      // --- 1X2
      const m1 = extract1X2(oddsArr);
      const imp1 = {
        "1": Number.isFinite(m1.medBy["1"]) ? 1/m1.medBy["1"] : 0,
        "X": Number.isFinite(m1.medBy["X"]) ? 1/m1.medBy["X"] : 0,
        "2": Number.isFinite(m1.medBy["2"]) ? 1/m1.medBy["2"] : 0
      };
      const n1 = norm3(imp1["1"], imp1["X"], imp1["2"]);
      let model1 = { "1": n1.A, "X": n1.B, "2": n1.C };
      // blend sa predictions (samo 1X2)
      if (Number.isFinite(pHome) || Number.isFinite(pDraw) || Number.isFinite(pAway)) {
        const ph = Number.isFinite(pHome) ? (pHome/100) : model1["1"];
        const pd = Number.isFinite(pDraw) ? (pDraw/100) : model1["X"];
        const pa = Number.isFinite(pAway) ? (pAway/100) : model1["2"];
        const s = ph+pd+pa; const nh = s>0 ? ph/s : 0; const nd = s>0 ? pd/s : 0; const na = s>0 ? pa/s : 0;
        model1 = {
          "1": MODEL_ALPHA*nh + (1-MODEL_ALPHA)*model1["1"],
          "X": MODEL_ALPHA*nd + (1-MODEL_ALPHA)*model1["X"],
          "2": MODEL_ALPHA*na + (1-MODEL_ALPHA)*model1["2"]
        };
      }
      // cap odstupanje per selekcija
      for (const k of ["1","X","2"]) {
        const cap = dynamicUpliftCap(m1.countsBy[k]||0, m1.spreadBy[k]||0);
        const implied = (k==="1")? (n1.A||0) : (k==="X")? (n1.B||0) : (n1.C||0);
        let v = model1[k];
        const diff = v - implied;
        if (diff > cap) v = implied + cap;
        if (diff < -cap) v = Math.max(0.0001, implied - cap);
        model1[k] = v;
      }
      { // renormalizuj
        const s = (model1["1"]||0)+(model1["X"]||0)+(model1["2"]||0);
        if (s>0){ model1={"1":model1["1"]/s,"X":model1["X"]/s,"2":model1["2"]/s}; }
      }

      // kandidati 1X2 (strogo/relaxed per selekcija)
      function candidates1X2(strict=true){
        const out=[];
        for (const k of ["1","X","2"]) {
          const price = m1.medBy[k]; if (!Number.isFinite(price)) continue;
          const books = m1.countsBy[k]||0;
          const spr = m1.spreadBy[k]||0;
          const prob = model1[k];
          const okBooks = books >= MIN_BOOKS_PER_SEL;
          const okSpread = strict ? spr <= SPREAD_STRICT : spr <= SPREAD_LOOSE;
          if (!okBooks || !okSpread) continue;
          const lab = pickLabel1X2(k);
          const c = buildCandidate(recBase, "1X2", k, lab, price, prob, books);
          if (c) out.push(c);
        }
        return out;
      }

      // --- BTTS (mora OBJE strane)
      const mb = extractBTTS(oddsArr);
      function candidatesBTTS(strict=true){
        const out=[];
        const haveY = Number.isFinite(mb.medBy.Y) && (mb.countsBy.Y||0) >= MIN_BOOKS_PER_SEL && (strict ? mb.spreadBy.Y <= SPREAD_STRICT : mb.spreadBy.Y <= SPREAD_LOOSE);
        const haveN = Number.isFinite(mb.medBy.N) && (mb.countsBy.N||0) >= MIN_BOOKS_PER_SEL && (strict ? mb.spreadBy.N <= SPREAD_STRICT : mb.spreadBy.N <= SPREAD_LOOSE);
        if (!(haveY && haveN)) return out;

        const impY = 1/mb.medBy.Y;
        const impN = 1/mb.medBy.N;
        const s = impY+impN;
        const pY = s>0 ? impY/s : null;
        const pN = s>0 ? impN/s : null;

        const cY = buildCandidate(recBase, "BTTS", "Y", "Yes", mb.medBy.Y, pY, mb.countsBy.Y||0);
        if (cY) out.push(cY);
        const cN = buildCandidate(recBase, "BTTS", "N", "No",  mb.medBy.N, pN, mb.countsBy.N||0);
        if (cN) out.push(cN);
        return out;
      }

      // --- OU 2.5 (mora OBJE strane)
      const mo = extractOU25(oddsArr);
      function candidatesOU(strict=true){
        const out=[];
        const haveO = Number.isFinite(mo.medBy.O) && (mo.countsBy.O||0) >= MIN_BOOKS_PER_SEL && (strict ? mo.spreadBy.O <= SPREAD_STRICT : mo.spreadBy.O <= SPREAD_LOOSE);
        const haveU = Number.isFinite(mo.medBy.U) && (mo.countsBy.U||0) >= MIN_BOOKS_PER_SEL && (strict ? mo.spreadBy.U <= SPREAD_STRICT : mo.spreadBy.U <= SPREAD_LOOSE);
        if (!(haveO && haveU)) return out;

        const impO = 1/mo.medBy.O;
        const impU = 1/mo.medBy.U;
        const s = impO+impU;
        const pO = s>0 ? impO/s : null;
        const pU = s>0 ? impU/s : null;

        const cO = buildCandidate(recBase, "OU2.5", "O2.5", "Over 2.5", mo.medBy.O, pO, mo.countsBy.O||0);
        if (cO) out.push(cO);
        const cU = buildCandidate(recBase, "OU2.5", "U2.5", "Under 2.5", mo.medBy.U, pU, mo.countsBy.U||0);
        if (cU) out.push(cU);
        return out;
      }

      // --- HT-FT (zahtev minimalne “punine” tržišta)
      const mh = extractHTFT(oddsArr);
      function candidatesHTFT(strict=true){
        const out=[];
        // izaberi validne kombinacije po pravilima
        const valid = [];
        const labels = { HH:"Home/Home", HD:"Home/Draw", HA:"Home/Away", DH:"Draw/Home", DD:"Draw/Draw", DA:"Draw/Away", AH:"Away/Home", AD:"Away/Draw", AA:"Away/Away" };
        for (const k of Object.keys(mh.medBy)) {
          const price = mh.medBy[k];
          const books = mh.countsBy[k]||0;
          const spr = mh.spreadBy[k]||0;
          const ok = Number.isFinite(price) && books>=MIN_BOOKS_PER_SEL && (strict ? spr<=SPREAD_STRICT : spr<=SPREAD_LOOSE);
          if (ok) valid.push(k);
        }
        const need = strict ? HTFT_MIN_COMBOS_STRICT : HTFT_MIN_COMBOS_RELAX;
        if (valid.length < need) return out;

        // implied-normalize kroz dostupne
        let sum=0; const imp = {};
        for (const k of valid) { const p = 1/mh.medBy[k]; imp[k]=p; sum+=p; }
        if (sum<=0) return out;

        for (const k of valid) {
          const prob = imp[k]/sum;
          const c = buildCandidate(recBase, "HT-FT", k, labels[k]||k, mh.medBy[k], prob, mh.countsBy[k]||0);
          if (c) out.push(c);
        }
        return out;
      }

      const strictCands = [
        ...candidates1X2(true),
        ...candidatesBTTS(true),
        ...candidatesOU(true),
        ...candidatesHTFT(true),
      ];
      if (strictCands.length) {
        strictCands.sort((a,b)=> (b.confidence_pct - a.confidence_pct) || (b._ev - a._ev));
        bestPerFixture_strict.push(strictCands[0]);
        dropStats.ok++;
      } else {
        const relaxedCands = [
          ...candidates1X2(false),
          ...candidatesBTTS(false),
          ...candidatesOU(false),
          ...candidatesHTFT(false),
        ];
        if (relaxedCands.length){
          relaxedCands.sort((a,b)=> (b.confidence_pct - a.confidence_pct) || (b._ev - a._ev));
          bestPerFixture_relaxed.push(relaxedCands[0]);
          dropStats.ok++;
        } else {
          dropStats.noPick++;
        }
      }
    }

    // rangiranje i preseci
    const prim = bestPerFixture_strict.length ? bestPerFixture_strict : bestPerFixture_relaxed;
    const mode = bestPerFixture_strict.length ? "strict" : "relaxed";
    const sorted = [...prim].sort((a,b)=> (b._ev - a._ev) || (b.confidence_pct - a.confidence_pct));
    const fullCount = Math.max(slotLimit, Math.min(sorted.length, 100));
    const slimCount = Math.min(slotLimit, sorted.length);
    const fullList = sorted.slice(0, fullCount);
    const slimList = sorted.slice(0, slimCount);

    // upis u KV
    let wrote=false;
    if (slimList.length>0) {
      const keySlim = `vbl:${ymd}:${slotQ}`;
      const keyFull = `vbl_full:${ymd}:${slotQ}`;
      const payloadSlim = { items: slimList, football: slimList, value_bets: slimList, source_meta:{mode} };
      const payloadFull = { items: fullList, football: fullList, value_bets: fullList, source_meta:{mode} };
      await kvSetJSON_safe(keySlim, payloadSlim);
      await kvSetJSON_safe(keyFull, payloadFull);

      // aliasi zbog kompatibilnosti
      await kvSetJSON_safe(`vb-locked:${ymd}:${slotQ}`, payloadSlim);
      await kvSetJSON_safe(`vb:locked:${ymd}:${slotQ}`, payloadSlim);
      await kvSetJSON_safe(`vb_locked:${ymd}:${slotQ}`, payloadSlim);
      await kvSetJSON_safe(`locked:vbl:${ymd}:${slotQ}`, payloadSlim);

      await kvSetJSON_safe(`vb:day:${ymd}:last`, {
        key: `vb-locked:${ymd}:${slotQ}`,
        alt: [keySlim, keyFull]
      });
      wrote = true;
    }

    return res.status(200).json({
      ok:true, slot:slotQ, ymd,
      count: slimList.length, count_full: fullList.length, wrote,
      football: slimList,
      ...(wantDebug ? { debug:{ ...debug, dropped: dropStats } } : {})
    });

  } catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
