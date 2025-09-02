// pages/api/cron/rebuild.js
// Slot rebuild (15/25 po slotu), objedinjeno biranje NAJBOLJEG predloga po utakmici
// preko 4 tržišta: 1X2, BTTS, OU 2.5, HT-FT.
//
// Ova verzija ublažava RELAXED pass pragove da bi slot (15–23:59) davao više realnih parova:
// - BTTS/OU2.5 i dalje zahtevaju OBE strane, ali u relaxed pass-u je min. books ≥2 (strogo je ≥3)
// - 1X2 relaxed: books ≥2 (strogo ≥3)
// - SPREAD_LOOSE podignut na 0.55 (strogo ostaje 0.25)
// - HT-FT: minimalno 3 validne kombinacije (strict) / 2 (relaxed)
// - Best-of-market po fixture-u ostaje: max confidence (tie-break EV). Globalni rang: EV → confidence.
// - Two-pass: ako strict ne vrati dovoljno, relaxed koristi iste payload-e (bez dodatnih API poziva).

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
      hour: Number(p.hour)
    };
  } catch {
    const d = new Date(dateIso);
    return { ymd: ymdInTZ(d, tz), hm: "00:00", hour: d.getUTCHours() };
  }
}

function envNum(name, def=0){
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

// kvalitet selekcije
const MIN_BOOKS_STRICT = 3;      // strogo: min broj knjiga po selekciji
const MIN_BOOKS_RELAX  = 2;      // relaxed: blaže
const EV_FLOOR = 0.02;           // minimalni EV za ulaz u listu (2%)
const SPREAD_STRICT = 0.25;      // spread (mx/mn - 1) strogo
const SPREAD_LOOSE  = 0.55;      // spread opušteno (povišen radi pokrivanja kasnijih mečeva)

// --- EV konzervativni parametri (donja granica) + težina za stat sloj ---
const EV_Z = envNum("EV_Z", 0.67);                // z-score penal za nesigurnost p
const EV_LB_FLOOR = envNum("EV_LB_FLOOR", 0.005); // minimalni EV-LB (0.5%)

// Statistika: uključivanje + težine i limit
const STATS_ENABLED = envBool("STATS_ENABLED", true);
const STATS_WEIGHT  = Math.max(0, Math.min(0.5, envNum("STATS_WEIGHT", 0.35)));
const H2H_WEIGHT    = Math.max(0, Math.min(0.4, envNum("H2H_WEIGHT", 0.15)));
const STATS_TEAM_LAST = Math.max(5, envNum("STATS_TEAM_LAST", 12)); // poslednjih N mečeva
const CONSIDER_ALL_FIXTURES = envBool("CONSIDER_ALL_FIXTURES", true);

// helper: najbolja dostupna kvota za datu selekciju (fallback na medijanu)
function bestPrice(m, k) {
  try {
    const arr = (m?.by?.[k] || []).filter(Number.isFinite);
    if (arr.length) return Math.max(...arr);
    const v = m?.medBy?.[k];
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

// EV-LB: donja granica EV-a, penalizuje p po broju knjiga (jednostavno, stabilno)
function evLowerBound(price, prob, booksCount){
  const N = Math.max(1, booksCount||0);
  const sigma = Math.sqrt(Math.max(1e-9, prob*(1-prob)/N));
  const p_lb = Math.max(0, prob - EV_Z * sigma);
  return price * p_lb - 1;
}

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

// --- Statističke funkcije (veselo trošimo API pozive da dobijemo jači signal) ---

async function fetchRecentForTeam(leagueId, season, teamId, lastN = STATS_TEAM_LAST) {
  if (!API_KEY || !teamId || !leagueId || !season) return null;
  try {
    const url = `${API_BASE.replace(/\/+$/, "")}/fixtures?team=${encodeURIComponent(teamId)}&league=${encodeURIComponent(leagueId)}&season=${encodeURIComponent(season)}&last=${encodeURIComponent(lastN)}`;
    const j = await getJSON(url);
    return Array.isArray(j?.response) ? j.response : [];
  } catch { return null; }
}

function computeTeamRecentStats(list, teamId) {
  const L = Array.isArray(list) ? list : [];
  let games=0, btts=0, over25=0, pts=0;
  for (const r of L) {
    const gh = Number(r?.goals?.home);
    const ga = Number(r?.goals?.away);
    const st = (r?.fixture?.status?.short || "").toUpperCase();
    if (!Number.isFinite(gh) || !Number.isFinite(ga)) continue;
    if (!/^FT|AET|PEN$/.test(st)) continue;
    games++;
    const homeId = r?.teams?.home?.id;
    const awayId = r?.teams?.away?.id;
    const sum = gh + ga;
    if (gh>0 && ga>0) btts++;
    if (sum>=3) over25++;
    // form points for the specific team
    const winnerHome = r?.teams?.home?.winner === true;
    const winnerAway = r?.teams?.away?.winner === true;
    if (homeId === teamId) {
      if (winnerHome) pts += 3;
      else if (!winnerHome && !winnerAway) pts += 1;
    } else if (awayId === teamId) {
      if (winnerAway) pts += 3;
      else if (!winnerHome && !winnerAway) pts += 1;
    }
  }
  if (!games) return null;
  return {
    games,
    bttsRate: btts/games,
    over25Rate: over25/games,
    formPct: pts/(games*3)
  };
}

async function fetchH2H(homeId, awayId, lastN = 10) {
  if (!API_KEY || !homeId || !awayId) return null;
  try {
    const url = `${API_BASE.replace(/\/+$/, "")}/fixtures/headtohead?h2h=${encodeURIComponent(homeId)}-${encodeURIComponent(awayId)}&last=${encodeURIComponent(lastN)}`;
    const j = await getJSON(url);
    return Array.isArray(j?.response) ? j.response : [];
  } catch { return null; }
}

function computeRatesFromFixtures(list) {
  const L = Array.isArray(list) ? list : [];
  let games=0, btts=0, over25=0;
  for (const r of L) {
    const gh = Number(r?.goals?.home);
    const ga = Number(r?.goals?.away);
    const st = (r?.fixture?.status?.short || "").toUpperCase();
    if (!Number.isFinite(gh) || !Number.isFinite(ga)) continue;
    if (!/^FT|AET|PEN$/.test(st)) continue;
    games++;
    const sum = gh+ga;
    if (gh>0 && ga>0) btts++;
    if (sum>=3) over25++;
  }
  if (!games) return null;
  return { games, bttsRate: btts/games, over25Rate: over25/games };
}

function combineTeamRates(homeRate, awayRate) {
  if (!Number.isFinite(homeRate) && !Number.isFinite(awayRate)) return null;
  if (!Number.isFinite(homeRate)) return awayRate;
  if (!Number.isFinite(awayRate)) return homeRate;
  return (homeRate + awayRate) / 2;
}

function formTo1X2Prob(homeFormPct, awayFormPct) {
  if (!Number.isFinite(homeFormPct) || !Number.isFinite(awayFormPct)) return null;
  const adv = 0.08; // home advantage ~8pp
  const h = Math.max(0.01, Math.min(0.99, homeFormPct + adv));
  const a = Math.max(0.01, Math.min(0.99, awayFormPct));
  const s = h + a;
  const pH = h / s;
  const pA = a / s;
  const pD = Math.max(0.05, 1 - (pH + pA));
  const k = (1 - pD) / (pH + pA);
  return { H: pH * k, D: pD, A: pA * k };
}

function mixProb(oddsProb, statProb, w = STATS_WEIGHT) {
  if (!Number.isFinite(statProb)) return oddsProb;
  const p = (1 - w) * oddsProb + w * statProb;
  return Math.max(0.02, Math.min(0.98, p));
}

// helpers
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
  const mn = Math.min(...a); const mx = Math.max(...a);
  if (!mn) return 0;
  return mx / mn - 1;
}

// 1X2
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
      if (!/^(1x2|match\s*winner|full\s*time\s*result)$/.test(nm)) continue;
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
        let code = null;
        if (lab === "yes" || lab === "y") code = "Y";
        else if (lab === "no" || lab === "n") code = "N";
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
      if (!/over\/under|totals/i.test(nm)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const label = (v?.value || v?.label || "").toString().toLowerCase().replace(/\s+/g, "");
        if (!/^o?2\.?5$|^u?2\.?5$|^over2\.5$|^under2\.5$/.test(label)) continue;
        const isOver = /^o|^over/.test(label);
        const code = isOver ? "O" : "U";
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
        seen[code].add(uniqueName(row));
      }
    }
  }
  const medBy = Object.fromEntries(Object.keys(by).map(k => [k, trimmedMedian(by[k])]));
  const countsBy = Object.fromEntries(Object.keys(by).map(k => [k, seen[k].size]));
  const spreadBy = Object.fromEntries(Object.keys(by).map(k => [k, spreadOf(by[k])]));
  return { by, medBy, countsBy, spreadBy };
}

function norm3(a, b, c) {
  const s = (a||0) + (b||0) + (c||0);
  if (s <= 0) return { A: 0, B: 0, C: 0 };
  return { A: a/s, B: b/s, C: c/s };
}
function pickLabel1X2(k){
  return k==="1" ? "Home" : k==="X" ? "Draw" : "Away";
}
function dynamicUpliftCap(books, spread) {
  // blagi limiter da ne beži od implied
  const b = Math.min(1, (books||0)/6);
  const s = 1 / (1 + 4*(spread||0));
  return Math.max(0.05, 0.20 * b * s); // max 20pp, često 5–12pp
}

// KV helperi
async function kvGetJSON(key) {
  const base = process.env.KV_REST_API_URL || "";
  const token = process.env.KV_REST_API_TOKEN || "";
  if (!base || !token) return null;
  const urlA = `${base.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
  let r = await fetch(urlA, { headers: { Authorization: `Bearer ${token}` } }).catch(()=>null);
  if (!r || !r.ok) return null;
  let raw = await r.text().catch(()=>null);
  try { return JSON.parse(raw); } catch { return null; }
}
async function kvSetJSON(key, value) {
  const base = process.env.KV_REST_API_URL || "";
  const token = process.env.KV_REST_API_TOKEN || "";
  if (!base || !token) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const urlA = `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}`;
  let r = await fetch(urlA, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }).catch(()=>null);
  if (r && r.ok) return true;

  // fallback forma
  const urlB = `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  r = await fetch(urlB, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(()=>null);
  if (r && r.ok) return true;

  const msg = r ? await r.text().catch(()=>String(r.status)) : "network-error";
  throw new Error(`KV set failed: ${msg.slice(0,200)}`);
}

// evaluacija kandidata po tržištu za jedan fixture
function buildCandidate(recBase, market, code, label, price, prob, booksCount, minBooksNeeded) {
  if (!Number.isFinite(price) || price < MIN_ODDS) return null;
  if (!Number.isFinite(prob)) return null;
  if (!Number.isFinite(booksCount) || booksCount < (minBooksNeeded ?? MIN_BOOKS_STRICT)) return null;

  const confidence_pct = Math.round(Math.max(0, Math.min(100, prob*100)));
  const _implied = Number((1/price).toFixed(4));
  const _ev = Number((price*prob - 1).toFixed(12));
  if (!Number.isFinite(_ev) || _ev < EV_FLOOR) return null;

  // konzervativna donja granica EV-a (EV-LB)
  const _ev_lb = Number(evLowerBound(price, prob, booksCount).toFixed(12));
  if (_ev_lb < EV_LB_FLOOR) return null;

  return {
    fixture_id: recBase.fixture_id,
    market, pick: label, pick_code: code, selection_label: label,
    model_prob: Number(prob.toFixed(4)),
    confidence_pct,
    odds: { price: Number(price), books_count: booksCount },
    league: recBase.league, league_name: recBase.league_name, league_country: recBase.league_country,
    teams: recBase.teams, home: recBase.home, away: recBase.away,
    kickoff: recBase.kickoff, kickoff_utc: recBase.kickoff_utc,
    _implied, _ev, _ev_lb,
  };
}

function isWomensLeague(leagueName="", teams={home:"",away:""}) {
  const s = `${leagueName} ${teams.home} ${teams.away}`.toLowerCase();
  return /\b(women|femin|femen|w\s*league|ladies|girls|女子|жен)\b/.test(s);
}

export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();
    const slotQ = String(req.query?.slot || "").toLowerCase() || "am";
    const isWeekend = [0,6].includes(new Date().getDay());
    const slotLimit = (slotQ === "late")
      ? LIMIT_LATE_WEEKDAY
      : (isWeekend ? DEFAULT_LIMIT_WEEKEND : DEFAULT_LIMIT_WEEKDAY);

    const debug = { slotQ, slotLimit };

    // slot window
    const slotWin = slotQ === "am" ? { hmin: 8, hmax: 13 }
                  : slotQ === "pm" ? { hmin: 13, hmax: 22 }
                  : { hmin: 22, hmax: 23 };

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
          league: { id: lg?.id, name: lg?.name, country: lg?.country, season: lg?.season },
          season: lg?.season,
          teams: { 
            home: home, 
            away: away,
            home_id: tm?.home?.id,
            away_id: tm?.away?.id
          }
        };
      })
      .filter(fx => fx.fixture_id && fx.date_utc != null);

    debug.after_basic = fixtures.length;

    fixtures = fixtures.filter(fx => fx.local_hour >= slotWin.hmin && fx.local_hour <= slotWin.hmax);
    debug.after_slot = fixtures.length;

    fixtures = fixtures.filter(fx => !isWomensLeague(fx.league?.name, fx.teams));
    debug.after_gender_filter = fixtures.length;

    // cap kandidata radi troška (opciono). Ako je CONSIDER_ALL_FIXTURES=1, ne sečemo listu.
    let considered = fixtures.length;
    if (!CONSIDER_ALL_FIXTURES) {
      considered = Math.min(fixtures.length, Math.max(slotLimit*6, slotLimit+40));
    }
    fixtures = fixtures.slice(0, considered);
    debug.considered = fixtures.length;

    const bestPerFixture_strict = [];
    theLoop:
    for (const fx of fixtures) {
      // payloadi (jednom po fixture-u)
      const oddsPayload = await fetchOddsForFixture(fx.fixture_id);

      const oddsArr = Array.isArray(oddsPayload) ? oddsPayload : [];
      if (!oddsArr.length) continue;

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
      for (const k of ["1","X","2"]) {
        const cap = dynamicUpliftCap(m1.countsBy[k]||0, m1.spreadBy[k]||0);
        const implied = (k==="1")? (n1.A||0) : (k==="X")? (n1.B||0) : (n1.C||0);
        let v = model1[k];
        const diff = v - implied;
        if (diff > cap) v = implied + cap;
        if (diff < -cap) v = Math.max(0.0001, implied - cap);
        model1[k] = v;
      }
      { const s = (model1["1"]||0)+(model1["X"]||0)+(model1["2"]||0); if (s>0){ model1={"1":model1["1"]/s,"X":model1["X"]/s,"2":model1["2"]/s}; } }

      function candidates1X2(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;
        for (const k of ["1","X","2"]) {
          const price = bestPrice(m1, k); if (!Number.isFinite(price)) continue;
          const books = m1.countsBy[k]||0;
          const spr = m1.spreadBy[k]||0;
          const prob = model1[k];
          if (books < needBooks || spr > sprLimit) continue;
          const lab = pickLabel1X2(k);
          const c = buildCandidate(recBase, "1X2", k, lab, price, prob, books, needBooks);
          if (c) out.push(c);
        }
        return out;
      }

      // --- BTTS
      const mb = extractBTTS(oddsArr);
      function candidatesBTTS(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;

        const haveY = Number.isFinite(mb.medBy.Y) && (mb.countsBy.Y||0) >= needBooks && (mb.spreadBy.Y||0) <= sprLimit;
        const haveN = Number.isFinite(mb.medBy.N) && (mb.countsBy.N||0) >= needBooks && (mb.spreadBy.N||0) <= sprLimit;
        if (!(haveY && haveN)) return out;

        const impY = 1/mb.medBy.Y;
        const impN = 1/mb.medBy.N;
        const s = impY+impN;
        const pY = s>0 ? impY/s : null;
        const pN = s>0 ? impN/s : null;

        const cY = buildCandidate(recBase, "BTTS", "Y", "Yes", bestPrice(mb,"Y"), pY, mb.countsBy.Y||0, needBooks);
        if (cY) out.push(cY);
        const cN = buildCandidate(recBase, "BTTS", "N", "No",  bestPrice(mb,"N"), pN, mb.countsBy.N||0, needBooks);
        if (cN) out.push(cN);
        return out;
      }

      // --- OU 2.5
      const mo = extractOU25(oddsArr);
      function candidatesOU(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;

        const haveO = Number.isFinite(mo.medBy.O) && (mo.countsBy.O||0) >= needBooks && (mo.spreadBy.O||0) <= sprLimit;
        const haveU = Number.isFinite(mo.medBy.U) && (mo.countsBy.U||0) >= needBooks && (mo.spreadBy.U||0) <= sprLimit;
        if (!(haveO && haveU)) return out;

        const impO = 1/mo.medBy.O;
        const impU = 1/mo.medBy.U;
        const s = impO+impU;
        const pO = s>0 ? impO/s : null;
        const pU = s>0 ? impU/s : null;

        const cO = buildCandidate(recBase, "OU2.5", "O2.5", "Over 2.5", bestPrice(mo,"O"), pO, mo.countsBy.O||0, needBooks);
        if (cO) out.push(cO);
        const cU = buildCandidate(recBase, "OU2.5", "U2.5", "Under 2.5", bestPrice(mo,"U"), pU, mo.countsBy.U||0, needBooks);
        if (cU) out.push(cU);
        return out;
      }

      // --- HT-FT
      const mh = extractHTFT(oddsArr);
      function candidatesHTFT(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;

        const valid = [];
        const labels = { HH:"Home/Home", HD:"Home/Draw", HA:"Home/Away", DH:"Draw/Home", DD:"Draw/Draw", DA:"Draw/Away", AH:"Away/Home", AD:"Away/Draw", AA:"Away/Away" };
        for (const k of Object.keys(mh.medBy)) {
          const price = bestPrice(mh,k); if (!Number.isFinite(price)) continue;
          const books = mh.countsBy[k]||0;
          const spr = mh.spreadBy[k]||0;
          if (books >= needBooks && spr <= sprLimit) valid.push(k);
        }
        const minCombos = strict ? 3 : 2;
        if (valid.length < minCombos) return out;

        // raspodela iz 1X2 kao rudimentarna verovatnoća HT-FT (zadrži tržišnu dominaciju)
        const approxProb = { HH: 0.34, HD: 0.11, HA: 0.06, DH: 0.13, DD: 0.14, DA: 0.08, AH: 0.06, AD: 0.08, AA: 0.10 };
        for (const k of valid) {
          const prob = approxProb[k] ?? 0.05;
          const c = buildCandidate(recBase, "HT-FT", k, labels[k]||k, bestPrice(mh,k), prob, mh.countsBy[k]||0, needBooks);
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
      // --- STAT BOOST (skupo, ali preciznije): kombinuje odds-prob sa timskim i H2H metrikama
      if (STATS_ENABLED) {
        try {
          const leagueId = fx.league?.id;
          const season   = fx.season || fx.league?.season;
          const homeId   = fx?.teams?.home_id;
          const awayId   = fx?.teams?.away_id;

          const [homeList, awayList, h2hList] = await Promise.all([
            fetchRecentForTeam(leagueId, season, homeId, STATS_TEAM_LAST),
            fetchRecentForTeam(leagueId, season, awayId, STATS_TEAM_LAST),
            fetchH2H(homeId, awayId, Math.min(10, STATS_TEAM_LAST))
          ]);

          const hs = computeTeamRecentStats(homeList, homeId);
          const as = computeTeamRecentStats(awayList, awayId);
          const hh = computeRatesFromFixtures(h2hList);

          let pBTTS_stat = combineTeamRates(hs?.bttsRate, as?.bttsRate);
          let pOU25_stat = combineTeamRates(hs?.over25Rate, as?.over25Rate);
          if (hh) {
            if (Number.isFinite(pBTTS_stat)) pBTTS_stat = (1 - H2H_WEIGHT) * pBTTS_stat + H2H_WEIGHT * hh.bttsRate;
            else pBTTS_stat = hh.bttsRate;
            if (Number.isFinite(pOU25_stat)) pOU25_stat = (1 - H2H_WEIGHT) * pOU25_stat + H2H_WEIGHT * hh.over25Rate;
            else pOU25_stat = hh.over25Rate;
          }
          const form1x2 = (hs?.formPct != null && as?.formPct != null) ? formTo1X2Prob(hs.formPct, as.formPct) : null;

          // primeni na kandidate ovog fixture-a
          const applyStats = (arr) => {
            for (const c of arr) {
              if (!c || c.fixture_id !== fx.fixture_id) continue;
              const price = c?.odds?.price;
              const books = c?.odds?.books_count || 1;

              if (c.market === "BTTS") {
                const p_odds = c.model_prob;
                const p_stat = (c.pick_code === "Y") ? pBTTS_stat : (Number.isFinite(pBTTS_stat) ? (1 - pBTTS_stat) : null);
                c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));
                c._ev = Number((price * c.model_prob - 1).toFixed(12));
                c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              }
              if (c.market === "OU2.5") {
                const p_odds = c.model_prob;
                let p_stat = pOU25_stat;
                if (Number.isFinite(p_stat) && c.pick_code === "U2.5") p_stat = 1 - p_stat;
                c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));
                c._ev = Number((price * c.model_prob - 1).toFixed(12));
                c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              }
              if (c.market === "1X2" && form1x2) {
                const p_odds = c.model_prob;
                const p_stat = (c.pick_code === "1") ? form1x2.H
                              : (c.pick_code === "X") ? form1x2.D
                              : (c.pick_code === "2") ? form1x2.A : null;
                c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));
                c._ev = Number((price * c.model_prob - 1).toFixed(12));
                c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              }
            }
          };
          applyStats(strictCands);
        } catch(e) {
          // ne rušimo slot ako stat pozivi omanu
        }
      }
      if (strictCands.length) {
        strictCands.sort((a,b)=> ( (b._ev_lb ?? b._ev) - (a._ev_lb ?? a._ev) ) || (b.confidence_pct - a.confidence_pct));
        bestPerFixture_strict.push(strictCands[0]);
      } else {
        const relaxedCands = [
          ...candidates1X2(false),
          ...candidatesBTTS(false),
          ...candidatesOU(false),
          ...candidatesHTFT(false),
        ];
        if (STATS_ENABLED) {
          try {
            const leagueId = fx.league?.id;
            const season   = fx.season || fx.league?.season;
            const homeId   = fx?.teams?.home_id;
            const awayId   = fx?.teams?.away_id;

            const [homeList, awayList, h2hList] = await Promise.all([
              fetchRecentForTeam(leagueId, season, homeId, STATS_TEAM_LAST),
              fetchRecentForTeam(leagueId, season, awayId, STATS_TEAM_LAST),
              fetchH2H(homeId, awayId, Math.min(10, STATS_TEAM_LAST))
            ]);

            const hs = computeTeamRecentStats(homeList, homeId);
            const as = computeTeamRecentStats(awayList, awayId);
            const hh = computeRatesFromFixtures(h2hList);

            let pBTTS_stat = combineTeamRates(hs?.bttsRate, as?.bttsRate);
            let pOU25_stat = combineTeamRates(hs?.over25Rate, as?.over25Rate);
            if (hh) {
              if (Number.isFinite(pBTTS_stat)) pBTTS_stat = (1 - H2H_WEIGHT) * pBTTS_stat + H2H_WEIGHT * hh.bttsRate;
              else pBTTS_stat = hh.bttsRate;
              if (Number.isFinite(pOU25_stat)) pOU25_stat = (1 - H2H_WEIGHT) * pOU25_stat + H2H_WEIGHT * hh.over25Rate;
              else pOU25_stat = hh.over25Rate;
            }
            const form1x2 = (hs?.formPct != null && as?.formPct != null) ? formTo1X2Prob(hs.formPct, as.formPct) : null;

            for (const c of relaxedCands) {
              if (!c || c.fixture_id !== fx.fixture_id) continue;
              const price = c?.odds?.price;
              const books = c?.odds?.books_count || 1;

              if (c.market === "BTTS") {
                const p_odds = c.model_prob;
                const p_stat = (c.pick_code === "Y") ? pBTTS_stat : (Number.isFinite(pBTTS_stat) ? (1 - pBTTS_stat) : null);
                c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));
                c._ev = Number((price * c.model_prob - 1).toFixed(12));
                c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              }
              if (c.market === "OU2.5") {
                const p_odds = c.model_prob;
                let p_stat = pOU25_stat;
                if (Number.isFinite(p_stat) && c.pick_code === "U2.5") p_stat = 1 - p_stat;
                c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));
                c._ev = Number((price * c.model_prob - 1).toFixed(12));
                c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              }
              if (c.market === "1X2" && form1x2) {
                const p_odds = c.model_prob;
                const p_stat = (c.pick_code === "1") ? form1x2.H
                              : (c.pick_code === "X") ? form1x2.D
                              : (c.pick_code === "2") ? form1x2.A : null;
                c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));
                c._ev = Number((price * c.model_prob - 1).toFixed(12));
                c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              }
            }
          } catch(e) {}
        }
        if (relaxedCands.length){
          relaxedCands.sort((a,b)=> ( (b._ev_lb ?? b._ev) - (a._ev_lb ?? a._ev) ) || (b.confidence_pct - a.confidence_pct));
          bestPerFixture_strict.push(relaxedCands[0]); // koristimo isti skup
        }
      }
    }

    // rangiranje i preseci
    const sorted = bestPerFixture_strict.sort((a,b)=> ((b._ev_lb ?? b._ev) - (a._ev_lb ?? a._ev)) || (b.confidence_pct - a.confidence_pct));
    const fullCount = Math.max(slotLimit, Math.min(sorted.length, 100));
    const slimCount = Math.min(slotLimit, sorted.length);
    const fullList = sorted.slice(0, fullCount);
    const slimList = sorted.slice(0, slimCount);

    // upis u KV
    let wrote=false;
    if (slimList.length>0) {
      const keySlim = `vbl:${ymd}:${slotQ}`;
      const keyFull = `vbl_full:${ymd}:${slotQ}`;
      const payloadSlim = { items: slimList, at: new Date().toISOString(), ymd, slot: slotQ };
      const payloadFull = { items: fullList, at: new Date().toISOString(), ymd, slot: slotQ };
      await kvSetJSON(keySlim, payloadSlim);
      await kvSetJSON(keyFull, payloadFull);
      // union touch
      const unionKey = `vb:day:${ymd}:union`;
      const union = Array.from(new Map(sorted.map(x => [x.fixture_id, x])).values());
      await kvSetJSON(unionKey, union);
      wrote = true;
    }

    return res.status(200).json({
      ok:true, slot:slotQ, ymd,
      count: slimList.length, count_full: fullList.length, wrote,
      football: slimList
    });

  } catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
