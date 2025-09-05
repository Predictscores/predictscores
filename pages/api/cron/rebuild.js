// pages/api/cron/rebuild.js 
// Slot rebuild sa 3 slota (late/am/pm), realnijim EV-om (median price),
// sum-safe clamp-om za 1X2, fallback-om za OU/BTTS, fill-to-limit,
// i blagom "learning" kalibracijom (čitanje iz vb:cal:v1).
// ⬇️ TARGET po dogovoru: am/pm radnim danima = 15, am/pm vikendom = 20, late = 6

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

/* ---------------- time helpers ---------------- */
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

/* ---------------- env helpers ---------------- */
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
function inListLowerIncludes(nameLower, list) {
  if (!list || !list.length) return true;
  const n = String(nameLower||"").toLowerCase();
  return list.some(t => n.includes(t));
}

/* ---------------- global knobs ---------------- */
// ⬇️ dogovoreni limiti (mogu se override-ovati env varovima)
const LIMIT_AMPM_WEEKDAY = envNum("SLOT_WEEKDAY_LIMIT", 15);
const LIMIT_AMPM_WEEKEND = envNum("SLOT_WEEKEND_LIMIT", 20);
const LIMIT_LATE_ANY     = envNum("SLOT_LATE_LIMIT", 6);

const MIN_ODDS = envNum("MIN_ODDS", 1.01);
const MODEL_ALPHA = envNum("MODEL_ALPHA", 0.4);

const EXCLUDE_WOMEN     = envBool("EXCLUDE_WOMEN", true);
const EXCLUDE_LOW_TIERS = envBool("EXCLUDE_LOW_TIERS", true);

const ODDS_TRUSTED_ONLY = envBool("ODDS_TRUSTED_ONLY", true);
const TRUSTED_BOOKIES   = envList("TRUSTED_BOOKIES", "TRUSTED_BOOKMAKERS");
let SHARP_BOOKIES       = envList("SHARP_BOOKIES", "");
if (!SHARP_BOOKIES.length) {
  SHARP_BOOKIES = ["ps3838","pinnacle","sbo","sbobet","betfair","exchange","matchbook"];
}

/* pragovi */
const MIN_BOOKS_STRICT    = 3;
const MIN_BOOKS_RELAX     = 2;                    // OU/BTTS relaxed = 2 (volumen)
const MIN_BOOKS_RELAX_1X2 = envNum("MIN_BOOKS_RELAX_1X2", 3); // 1X2 relaxed = 3

const EV_FLOOR      = envNum("EV_FLOOR", 0.02);
const SPREAD_STRICT = 0.25;
const SPREAD_LOOSE  = 0.55;

const EV_Z        = envNum("EV_Z", 0.67);
const EV_LB_FLOOR = envNum("EV_LB_FLOOR", 0.005);

const STATS_ENABLED   = envBool("STATS_ENABLED", true);
const STATS_WEIGHT    = Math.max(0, Math.min(0.5, envNum("STATS_WEIGHT", 0.35)));
const H2H_WEIGHT      = Math.max(0, Math.min(0.4,  envNum("H2H_WEIGHT", 0.15)));
const STATS_TEAM_LAST = Math.max(5, envNum("STATS_TEAM_LAST", 12));

/* ---------------- utils ---------------- */
function trimmedMedian(a) {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (x.length >= 5) { x.shift(); x.pop(); }
  if (!x.length) return NaN;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function spreadOf(arr) {
  const a = arr.filter(Number.isFinite);
  if (a.length < 2) return 0;
  const mn = Math.min(...a); const mx = Math.max(...a);
  if (!mn) return 0;
  return mx / mn - 1;
}
function norm3(a, b, c) {
  const s = (a||0) + (b||0) + (c||0);
  if (s <= 0) return { A: 0, B: 0, C: 0 };
  return { A: a/s, B: b/s, C: c/s };
}
function pickLabel1X2(k){ return k==="1" ? "Home" : k==="X" ? "Draw" : "Away"; }

function evLowerBound(price, prob, booksCount){
  const N = Math.max(1, booksCount||0);
  const sigma = Math.sqrt(Math.max(1e-9, prob*(1-prob)/N));
  const p_lb = Math.max(0, prob - EV_Z * sigma);
  return price * p_lb - 1;
}

function dynamicUpliftCap(books, spread) {
  const b = Math.min(1, (books||0)/6);
  const s = 1 / (1 + 4*(spread||0));
  return Math.max(0.05, 0.20 * b * s); // max 20pp
}

// MEDIAN cena za EV
function priceMedian(m, k) {
  try {
    const arr = (m?.by?.[k] || []).filter(Number.isFinite);
    if (arr.length) return trimmedMedian(arr);
    const v = m?.medBy?.[k];
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}
function bestPrice(m, k) { // ostavljeno za reference
  try {
    const arr = (m?.by?.[k] || []).filter(Number.isFinite);
    if (arr.length) return Math.max(...arr);
    const v = m?.medBy?.[k];
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function isWomensLeague(leagueName="", teams={home:"",away:""}) {
  const s = `${leagueName} ${teams.home} ${teams.away}`.toLowerCase();
  return /\b(women|femin|femen|femenino|feminina|w\s*league|ladies|girls|女子|жен)\b/.test(s);
}
function lowTierMention(s=""){
  return /\b(U1[7-9]|U2[0-3]|U-1[7-9]|U-2[0-3]|Youth|Reserves|Reserve|II\b| B\b|B Team|Academy|U21|U23)\b/i.test(s);
}
function isLowTier(leagueName="", teams={home:"",away:""}){
  return lowTierMention(leagueName) || lowTierMention(teams.home||"") || lowTierMention(teams.away||"");
}

/* ---------------- API-Football ---------------- */
const API_BASE = process.env.API_FOOTBALL_BASE_URL || process.env.API_FOOTBALL || "https://v3.football.api-sports.io";
const API_KEY  = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL || "";
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

/* ---------------- Statistike ---------------- */
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

/* ---------------- odds extraction (FAIR vs PRICE) ---------------- */
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
function uniqueName(row) {
  return String(row?.name ?? row?.bookmaker?.name ?? row?.id ?? row?.bookmaker ?? "").toLowerCase();
}

function extract1X2(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const anyBy  = { "1": [], "X": [], "2": [] };
  const fairBy = { "1": [], "X": [], "2": [] };
  const fairSeen = { "1": new Set(), "X": new Set(), "2": new Set() };

  for (const row of rows) {
    const bkm = uniqueName(row);
    const allowAny  = !ODDS_TRUSTED_ONLY || inListLowerIncludes(bkm, TRUSTED_BOOKIES);
    const allowFair = inListLowerIncludes(bkm, SHARP_BOOKIES);
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
        if (allowAny)  anyBy[code].push(price);
        if (allowFair) { fairBy[code].push(price); fairSeen[code].add(bkm); }
      }
    }
  }
  const medBy    = { "1": trimmedMedian(fairBy["1"]), "X": trimmedMedian(fairBy["X"]), "2": trimmedMedian(fairBy["2"]) };
  const countsBy = { "1": fairSeen["1"].size,          "X": fairSeen["X"].size,          "2": fairSeen["2"].size };
  const spreadBy = { "1": spreadOf(fairBy["1"]),       "X": spreadOf(fairBy["X"]),       "2": spreadOf(fairBy["2"]) };
  return { by: anyBy, medBy, countsBy, spreadBy };
}
function extractBTTS(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const anyBy  = { Y: [], N: [] };
  const fairBy = { Y: [], N: [] };
  const fairSeen = { Y: new Set(), N: new Set() };

  for (const row of rows) {
    const bkm = uniqueName(row);
    const allowAny  = !ODDS_TRUSTED_ONLY || inListLowerIncludes(bkm, TRUSTED_BOOKIES);
    const allowFair = inListLowerIncludes(bkm, SHARP_BOOKIES);
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
        if (allowAny)  anyBy[code].push(price);
        if (allowFair) { fairBy[code].push(price); fairSeen[code].add(bkm); }
      }
    }
  }
  const medBy    = { Y: trimmedMedian(fairBy.Y), N: trimmedMedian(fairBy.N) };
  const countsBy = { Y: fairSeen.Y.size,         N: fairSeen.N.size };
  const spreadBy = { Y: spreadOf(fairBy.Y),      N: spreadOf(fairBy.N) };
  return { by: anyBy, medBy, countsBy, spreadBy };
}
function extractOU25(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const anyBy  = { O: [], U: [] };
  const fairBy = { O: [], U: [] };
  const fairSeen = { O: new Set(), U: new Set() };

  for (const row of rows) {
    const bkm = uniqueName(row);
    const allowAny  = !ODDS_TRUSTED_ONLY || inListLowerIncludes(bkm, TRUSTED_BOOKIES);
    const allowFair = inListLowerIncludes(bkm, SHARP_BOOKIES);
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
        if (allowAny)  anyBy[code].push(price);
        if (allowFair) { fairBy[code].push(price); fairSeen[code].add(bkm); }
      }
    }
  }
  const medBy    = { O: trimmedMedian(fairBy.O), U: trimmedMedian(fairBy.U) };
  const countsBy = { O: fairSeen.O.size,         U: fairSeen.U.size };
  const spreadBy = { O: spreadOf(fairBy.O),      U: spreadOf(fairBy.U) };
  return { by: anyBy, medBy, countsBy, spreadBy };
}
function extractHTFT(oddsPayload) {
  const rows = extractRows(oddsPayload);
  const keys = ["HH","HD","HA","DH","DD","DA","AH","AD","AA"];
  const anyBy  = Object.fromEntries(keys.map(k => [k, []]));
  const fairBy = Object.fromEntries(keys.map(k => [k, []]));
  const fairSeen = Object.fromEntries(keys.map(k => [k, new Set()]));

  for (const row of rows) {
    const bkm = uniqueName(row);
    const allowAny  = !ODDS_TRUSTED_ONLY || inListLowerIncludes(bkm, TRUSTED_BOOKIES);
    const allowFair = inListLowerIncludes(bkm, SHARP_BOOKIES);
    the bets = Array.isArray(row?.bets) ? row.bets : [];
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
        if (allowAny)  anyBy[code].push(price);
        if (allowFair) { fairBy[code].push(price); fairSeen[code].add(bkm); }
      }
    }
  }
  const medBy    = Object.fromEntries(keys.map(k => [k, trimmedMedian(fairBy[k])]));
  const countsBy = Object.fromEntries(keys.map(k => [k, fairSeen[k].size]));
  const spreadBy = Object.fromEntries(keys.map(k => [k, spreadOf(fairBy[k])]));
  return { by: anyBy, medBy, countsBy, spreadBy };
}

/* ---------------- KV ---------------- */
async function kvGetJSON(key) {
  const base = process.env.KV_REST_API_URL || "";
  const token = process.env.KV_REST_API_TOKEN || "";
  if (!base || !token) return null;
  const urlA = `${base.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(urlA, { headers: { Authorization: `Bearer ${token}` } }).catch(()=>null);
  if (!r || !r.ok) return null;
  const raw = await r.text().catch(()=>null);
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
  const urlB = `${base.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  r = await fetch(urlB, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(()=>null);
  if (r && r.ok) return true;
  const msg = r ? await r.text().catch(()=>String(r.status)) : "network-error";
  throw new Error(`KV set failed: ${msg.slice(0,200)}`);
}

/* ---------------- Learning kalibracija ---------------- */
function calFactor(cal, market, pick){
  const node = cal?.[String(market).toUpperCase()]?.[String(pick).toUpperCase()];
  if(!node || (node.n||0) < 50) return 1;
  const meanObs  = (node.wins + 2) / (node.n + 4);           // Laplace smoothing
  const meanPred = (node.sum_p + 1e-6) / (node.n + 1e-6);
  let r = meanObs / Math.max(0.01, Math.min(0.99, meanPred));
  r = Math.max(0.9, Math.min(1.1, r));                       // cap ±10%
  return Math.pow(r, 0.5);                                   // blaga polovina
}

/* ---------------- candidate builder ---------------- */
function buildCandidate(recBase, market, code, label, price, prob, booksCount, minBooksNeeded) {
  if (!Number.isFinite(price) || price < MIN_ODDS) return null;
  if (!Number.isFinite(prob)) return null;
  if (!Number.isFinite(booksCount) || booksCount < (minBooksNeeded ?? MIN_BOOKS_STRICT)) return null;

  const confidence_pct = Math.round(Math.max(0, Math.min(100, prob*100)));
  const _implied = Number((1/price).toFixed(4));
  const _ev = Number((price*prob - 1).toFixed(12));
  if (!Number.isFinite(_ev) || _ev < EV_FLOOR) return null;

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
// Loose varijanta za fill-to-limit (bez EV-LB uslova, EV >= 0, blaži spread)
function buildCandidateLoose(recBase, market, code, label, price, prob, booksCount, minBooksNeeded) {
  if (!Number.isFinite(price) || price < MIN_ODDS) return null;
  if (!Number.isFinite(prob)) return null;
  if (!Number.isFinite(booksCount) || booksCount < (minBooksNeeded ?? MIN_BOOKS_STRICT)) return null;
  const _implied = Number((1/price).toFixed(4));
  const _ev = Number((price*prob - 1).toFixed(12));
  if (_ev < 0) return null;
  const confidence_pct = Math.round(Math.max(0, Math.min(100, prob*100)));
  const _ev_lb = Number(evLowerBound(price, prob, booksCount).toFixed(12));
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
    _loose: true
  };
}

/* ---------------- 1X2 sum-safe clamp ---------------- */
function sumSafeClamp1x2(implied, proposed, isX) {
  const keys = ["H","D","A"];
  const impl = { H: implied.H, D: implied.D, A: implied.A };
  const prop = { H: proposed.H, D: proposed.D, A: proposed.A };
  const bounds = {};
  for (const k of keys) {
    const p0 = Math.max(0.01, Math.min(0.97, impl[k] || 0));
    let up = Math.min(0.16, 0.6*(1 - p0));
    let dn = Math.min(0.16, 0.6*(p0));
    if (k === "D" && isX) { up = Math.max(0, up - 0.02); dn = Math.max(0, dn - 0.02); }
    bounds[k] = { up, dn };
  }
  const delta = {};
  let sumDelta = 0;
  for (const k of keys) {
    const d = (prop[k] || 0) - (impl[k] || 0);
    const cl = Math.max(-bounds[k].dn, Math.min(bounds[k].up, d));
    delta[k] = cl;
    sumDelta += cl;
  }
  if (Math.abs(sumDelta) >= 1e-12) {
    if (sumDelta > 0) {
      const room = keys.map(k => delta[k] - (-bounds[k].dn));
      let totalRoom = room.reduce((a,b)=>a+b,0) || 1;
      for (let i=0;i<keys.length;i++){
        const take = Math.min(sumDelta * (room[i]/totalRoom), room[i]);
        delta[keys[i]] -= take;
      }
    } else {
      const room = keys.map(k => bounds[k].up - delta[k]);
      let totalRoom = room.reduce((a,b)=>a+b,0) || 1;
      for (let i=0;i<keys.length;i++){
        const give = Math.min((-sumDelta) * (room[i]/totalRoom), room[i]);
        delta[keys[i]] += give;
      }
    }
  }
  const out = { H: impl.H + delta.H, D: impl.D + delta.D, A: impl.A + delta.A };
  const s = out.H + out.D + out.A;
  if (s > 0) { out.H/=s; out.D/=s; out.A/=s; }
  for (const k of keys) out[k] = Math.max(0.02, Math.min(0.98, out[k]));
  return out;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();
    const slotQ = String(req.query?.slot || "").toLowerCase() || "am";
    const window =
      slotQ === "late" ? { hmin: 0,  hmax: 9 }  :
      slotQ === "am"   ? { hmin: 10, hmax: 14 } :
                         { hmin: 15, hmax: 23 };

    // ⬇️ vikend u lokalnoj (TZ) zoni
    const isWeekendLocal = (() => {
      try {
        const wd = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" }).format(new Date());
        return wd === "Sat" || wd === "Sun";
      } catch { const d=new Date(); const gd=d.getUTCDay(); return gd===0 || gd===6; }
    })();

    // ⬇️ TARGET po slotu/danu: late=6, am/pm=15 (radni), am/pm=20 (vikend)
    const TARGET =
      slotQ === "late" ? LIMIT_LATE_ANY :
      (isWeekendLocal ? LIMIT_AMPM_WEEKEND : LIMIT_AMPM_WEEKDAY);

    // fixtures
    const raw = await fetchFixturesByDate(ymd);
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
      .filter(fx => fx.fixture_id && fx.date_utc != null)
      .filter(fx => fx.local_hour >= window.hmin && fx.local_hour <= window.hmax)
      .filter(fx => !(EXCLUDE_WOMEN && isWomensLeague(fx.league?.name, fx.teams)))
      .filter(fx => !(EXCLUDE_LOW_TIERS && isLowTier(fx.league?.name || "", fx.teams)));

    const bestPerFixture = [];
    const fillerByFixture = new Map();

    // učitaj kalibraciju (learning)
    const cal = await kvGetJSON('vb:cal:v1').catch(()=>null) || {};

    for (const fx of fixtures) {
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

      /* ---------- 1X2 ---------- */
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

      function getBooksCount(m, k) {
        const fair = Number(m?.countsBy?.[k] || 0);
        const any  = Array.isArray(m?.by?.[k]) ? m.by[k].length : 0;
        return Math.max(fair, any);
      }
      function getSpread(m, k) {
        const fairSpread = m?.spreadBy?.[k];
        if (Number.isFinite(fairSpread) && (m?.countsBy?.[k] || 0) > 0) return fairSpread;
        const arr = (m?.by?.[k] || []).filter(Number.isFinite);
        return spreadOf(arr);
      }

      function candidates1X2(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX_1X2;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;
        for (const k of ["1","X","2"]) {
          const price = priceMedian(m1, k); if (!Number.isFinite(price)) continue; // MEDIAN price za EV
          const books = getBooksCount(m1, k);
          const spr = getSpread(m1, k);
          const prob = model1[k];
          if (books < needBooks || spr > sprLimit) continue;
          const lab = pickLabel1X2(k);
          const c = buildCandidate(recBase, "1X2", k, lab, price, prob, books, needBooks);
          if (c) out.push(c);
        }
        return out;
      }

      /* ---------- BTTS ---------- */
      const mb = extractBTTS(oddsArr);
      function impliedBTTS() {
        let mY = mb.medBy.Y, mN = mb.medBy.N;
        if (!Number.isFinite(mY)) { const any = (mb.by.Y||[]).filter(Number.isFinite); if (any.length) mY = trimmedMedian(any); }
        if (!Number.isFinite(mN)) { const any = (mb.by.N||[]).filter(Number.isFinite); if (any.length) mN = trimmedMedian(any); }
        if (!Number.isFinite(mY) || !Number.isFinite(mN)) return null;
        const impY = 1/mY, impN = 1/mN;
        const s = impY + impN; if (s<=0) return null;
        return { pY: impY/s, pN: impN/s };
      }
      function candidatesBTTS(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;

        const probs = impliedBTTS();
        if (!probs) return out;

        const booksY = getBooksCount(mb,"Y");
        const booksN = getBooksCount(mb,"N");
        const sprY = getSpread(mb,"Y");
        const sprN = getSpread(mb,"N");
        const okY = booksY >= needBooks && sprY <= sprLimit && Number.isFinite(priceMedian(mb,"Y"));
        const okN = booksN >= needBooks && sprN <= sprLimit && Number.isFinite(priceMedian(mb,"N"));
        if (!okY && !okN) return out;

        if (okY) {
          const cY = buildCandidate(recBase, "BTTS", "Y", "Yes",
            priceMedian(mb,"Y"), probs.pY, booksY, needBooks);
          if (cY) out.push(cY);
        }
        if (okN) {
          const cN = buildCandidate(recBase, "BTTS", "N", "No",
            priceMedian(mb,"N"), probs.pN, booksN, needBooks);
          if (cN) out.push(cN);
        }
        return out;
      }

      /* ---------- OU 2.5 ---------- */
      const mo = extractOU25(oddsArr);
      function impliedOU() {
        let mO = mo.medBy.O, mU = mo.medBy.U;
        if (!Number.isFinite(mO)) { const any = (mo.by.O||[]).filter(Number.isFinite); if (any.length) mO = trimmedMedian(any); }
        if (!Number.isFinite(mU)) { const any = (mo.by.U||[]).filter(Number.isFinite); if (any.length) mU = trimmedMedian(any); }
        if (!Number.isFinite(mO) || !Number.isFinite(mU)) return null;
        const impO = 1/mO, impU = 1/mU;
        const s = impO + impU; if (s<=0) return null;
        return { pO: impO/s, pU: impU/s };
      }
      function candidatesOU(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;

        const probs = impliedOU();
        if (!probs) return out;

        const booksO = getBooksCount(mo,"O");
        const booksU = getBooksCount(mo,"U");
        const sprO = getSpread(mo,"O");
        const sprU = getSpread(mo,"U");
        const okO = booksO >= needBooks && sprO <= sprLimit && Number.isFinite(priceMedian(mo,"O"));
        const okU = booksU >= needBooks && sprU <= sprLimit && Number.isFinite(priceMedian(mo,"U"));
        if (!okO && !okU) return out;

        if (okO) {
          const cO = buildCandidate(recBase, "OU2.5", "O2.5", "Over 2.5",
            priceMedian(mo,"O"), probs.pO, booksO, needBooks);
          if (cO) out.push(cO);
        }
        if (okU) {
          const cU = buildCandidate(recBase, "OU2.5", "U2.5", "Under 2.5",
            priceMedian(mo,"U"), probs.pU, booksU, needBooks);
          if (cU) out.push(cU);
        }
        return out;
      }

      /* ---------- HT-FT ---------- */
      const mh = extractHTFT(oddsArr);
      function candidatesHTFT(strict=true){
        const out=[];
        const needBooks = strict ? MIN_BOOKS_STRICT : MIN_BOOKS_RELAX;
        const sprLimit = strict ? SPREAD_STRICT : SPREAD_LOOSE;

        const valid = [];
        const labels = { HH:"Home/Home", HD:"Home/Draw", HA:"Home/Away", DH:"Draw/Home", DD:"Draw/Draw", DA:"Draw/Away", AH:"Away/Home", AD:"Away/Draw", AA:"Away/Away" };
        for (const k of Object.keys(mh.medBy)) {
          const price = priceMedian(mh,k); if (!Number.isFinite(price)) continue;
          const books = getBooksCount(mh,k);
          const spr = getSpread(mh,k);
          if (books >= needBooks && spr <= sprLimit) valid.push(k);
        }
        const minCombos = strict ? 3 : 2;
        if (valid.length < minCombos) return out;

        const approxProb = { HH: 0.34, HD: 0.11, HA: 0.06, DH: 0.13, DD: 0.14, DA: 0.08, AH: 0.06, AD: 0.08, AA: 0.10 };
        for (const k of valid) {
          const prob = approxProb[k] ?? 0.05;
          const c = buildCandidate(recBase, "HT-FT", k, labels[k]||k, priceMedian(mh,k), prob, getBooksCount(mh,k), needBooks);
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

      /* ---------- STAT MIX + SUM-SAFE CLAMP + POST-FILTER + LEARNING ---------- */
      const applyStatsWithClamp = async (arr) => {
        if (!STATS_ENABLED || !arr.length) return arr;

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

          const canUseTeams = (hs?.games >= 5 && as?.games >= 5);   // ≥5 FT po timu
          const canUseH2H   = (hh && hh.games >= 4);                // ≥4 FT H2H

          let pBTTS_stat = canUseTeams ? combineTeamRates(hs?.bttsRate, as?.bttsRate) : null;
          let pOU25_stat = canUseTeams ? combineTeamRates(hs?.over25Rate, as?.over25Rate) : null;

          if (canUseTeams && canUseH2H) {
            if (Number.isFinite(pBTTS_stat)) pBTTS_stat = (1 - H2H_WEIGHT) * pBTTS_stat + H2H_WEIGHT * hh.bttsRate;
            if (Number.isFinite(pOU25_stat)) pOU25_stat = (1 - H2H_WEIGHT) * pOU25_stat + H2H_WEIGHT * hh.over25Rate;
          }

          const form1x2 = canUseTeams ? formTo1X2Prob(hs?.formPct, as?.formPct) : null;

          for (const c of arr) {
            if (!c || c.fixture_id !== fx.fixture_id) continue;
            const price = c?.odds?.price;
            const books = c?.odds?.books_count || 1;

            if (c.market === "BTTS") {
              const p_odds = c.model_prob;
              const p_stat = (c.pick_code === "Y") ? pBTTS_stat : (Number.isFinite(pBTTS_stat) ? (1 - pBTTS_stat) : null);
              c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));

              // learning kalibracija
              const f = calFactor(cal, c.market, c.pick_code);
              c.model_prob = Math.max(0.02, Math.min(0.98, c.model_prob * f));

              c._ev = Number((price * c.model_prob - 1).toFixed(12));
              c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              const strongMarket = books >= 5 && c._ev >= EV_FLOOR * 1.5;
              if (!strongMarket && !(c._ev >= EV_FLOOR && c._ev_lb >= EV_LB_FLOOR)) c._drop = true;
            }
            if (c.market === "OU2.5") {
              const p_odds = c.model_prob;
              let p_stat = pOU25_stat;
              if (Number.isFinite(p_stat) && c.pick_code === "U2.5") p_stat = 1 - p_stat;
              c.model_prob = Number(mixProb(p_odds, p_stat).toFixed(4));

              // learning kalibracija
              const f = calFactor(cal, c.market, c.pick_code);
              c.model_prob = Math.max(0.02, Math.min(0.98, c.model_prob * f));

              c._ev = Number((price * c.model_prob - 1).toFixed(12));
              c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              const strongMarket = books >= 5 && c._ev >= EV_FLOOR * 1.5;
              if (!strongMarket && !(c._ev >= EV_FLOOR && c._ev_lb >= EV_LB_FLOOR)) c._drop = true;
            }
            if (c.market === "1X2") {
              // stat-mix samo ako ima form signal
              let proposed = { H: null, D: null, A: null };
              const implied = {
                H: (1/m1.medBy["1"]) / ((1/m1.medBy["1"]) + (1/m1.medBy["X"]) + (1/m1.medBy["2"]) || 1),
                D: (1/m1.medBy["X"]) / ((1/m1.medBy["1"]) + (1/m1.medBy["X"]) + (1/m1.medBy["2"]) || 1),
                A: (1/m1.medBy["2"]) / ((1/m1.medBy["1"]) + (1/m1.medBy["X"]) + (1/m1.medBy["2"]) || 1)
              };

              if (form1x2) {
                proposed = {
                  H: (c.pick_code === "1") ? Number(mixProb(c.model_prob, form1x2.H).toFixed(4)) : model1["1"],
                  D: (c.pick_code === "X") ? Number(mixProb(c.model_prob, form1x2.D).toFixed(4)) : model1["X"],
                  A: (c.pick_code === "2") ? Number(mixProb(c.model_prob, form1x2.A).toFixed(4)) : model1["2"],
                };
                const out = sumSafeClamp1x2(implied, proposed, c.pick_code === "X");
                c.model_prob = Number( (c.pick_code === "1") ? out.H : (c.pick_code === "X") ? out.D : out.A );
              }

              // learning kalibracija
              const f = calFactor(cal, c.market, c.pick_code);
              c.model_prob = Math.max(0.02, Math.min(0.98, c.model_prob * f));

              // recompute EV/EV-LB i filter
              c._ev = Number((price * c.model_prob - 1).toFixed(12));
              c._ev_lb = Number(evLowerBound(price, c.model_prob, books).toFixed(12));
              const strongMarket = books >= 5 && c._ev >= EV_FLOOR * 1.5;
              if (!strongMarket && !(c._ev >= EV_FLOOR && c._ev_lb >= EV_LB_FLOOR)) c._drop = true;
            }
          }

          return arr.filter(x => !x? false : !x._drop);
        } catch (_) {
          return arr; // fail-safe
        }
      };

      // strict → stat → top-1; ako nema, relaxed → stat → top-1
      let pool = strictCands;
      if (pool.length) {
        pool = await applyStatsWithClamp(pool);
        if (pool.length){
          pool.sort((a,b)=> ( (b._ev_lb ?? b._ev) - (a._ev_lb ?? a._ev) ) || (b.confidence_pct - a.confidence_pct));
          bestPerFixture.push(pool[0]);
        }
      }
      if (!pool.length) {
        const relaxedCands = [
          ...candidates1X2(false),
          ...candidatesBTTS(false),
          ...candidatesOU(false),
          ...candidatesHTFT(false),
        ];
        let poolR = await applyStatsWithClamp(relaxedCands);
        if (poolR.length){
          poolR.sort((a,b)=> ( (b._ev_lb ?? b._ev) - (a._ev_lb ?? a._ev) ) || (b.confidence_pct - a.confidence_pct));
          bestPerFixture.push(poolR[0]);
        }
      }

      // --- pripremi “loose” fallback za ovaj fixture (bez stat-mixa) ---
      (function makeLoose1X2(){
        const needBooks = MIN_BOOKS_RELAX_1X2;
        const sprLimit = 0.70;
        const imp = {
          "1": Number.isFinite(m1.medBy["1"]) ? 1/m1.medBy["1"] : 0,
          "X": Number.isFinite(m1.medBy["X"]) ? 1/m1.medBy["X"] : 0,
          "2": Number.isFinite(m1.medBy["2"]) ? 1/m1.medBy["2"] : 0
        };
        const nn = norm3(imp["1"], imp["X"], imp["2"]);
        for (const k of ["1","X","2"]) {
          const price = priceMedian(m1,k); if (!Number.isFinite(price)) continue;
          const books = getBooksCount(m1,k);
          const spr = getSpread(m1,k);
          if (books < needBooks || spr > sprLimit) continue;
          const prob = (k==="1")? nn.A : (k==="X")? nn.B : nn.C;
          const lab = pickLabel1X2(k);
          const c = buildCandidateLoose(recBase, "1X2", k, lab, price, prob, books, needBooks);
          if (c) {
            const prev = fillerByFixture.get(fx.fixture_id);
            if (!prev || (c._ev > prev._ev)) fillerByFixture.set(fx.fixture_id, c);
          }
        }
      })();

      (function makeLooseBTTS(){
        const needBooks = MIN_BOOKS_RELAX;
        const sprLimit = 0.70;
        const probs = (function(){
          let mY = mb.medBy.Y, mN = mb.medBy.N;
          if (!Number.isFinite(mY)) { const any = (mb.by.Y||[]).filter(Number.isFinite); if (any.length) mY = trimmedMedian(any); }
          if (!Number.isFinite(mN)) { const any = (mb.by.N||[]).filter(Number.isFinite); if (any.length) mN = trimmedMedian(any); }
          if (!Number.isFinite(mY) || !Number.isFinite(mN)) return null;
          const impY = 1/mY, impN = 1/mN; const s = impY+impN; if (s<=0) return null;
          return { pY: impY/s, pN: impN/s };
        })();
        if (!probs) return;
        const booksY = getBooksCount(mb,"Y"), booksN = getBooksCount(mb,"N");
        const sprY = getSpread(mb,"Y"),     sprN = getSpread(mb,"N");
        if (booksY >= needBooks && sprY <= sprLimit && Number.isFinite(priceMedian(mb,"Y"))) {
          const c = buildCandidateLoose(recBase, "BTTS", "Y", "Yes", priceMedian(mb,"Y"), probs.pY, booksY, needBooks);
          if (c) { const prev = fillerByFixture.get(fx.fixture_id); if (!prev || c._ev > prev._ev) fillerByFixture.set(fx.fixture_id, c); }
        }
        if (booksN >= needBooks && sprN <= sprLimit && Number.isFinite(priceMedian(mb,"N"))) {
          const c = buildCandidateLoose(recBase, "BTTS", "N", "No", priceMedian(mb,"N"), probs.pN, booksN, needBooks);
          if (c) { const prev = fillerByFixture.get(fx.fixture_id); if (!prev || c._ev > prev._ev) fillerByFixture.set(fx.fixture_id, c); }
        }
      })();

      (function makeLooseOU(){
        const needBooks = MIN_BOOKS_RELAX;
        const sprLimit = 0.70;
        const probs = (function(){
          let mO = mo.medBy.O, mU = mo.medBy.U;
          if (!Number.isFinite(mO)) { const any = (mo.by.O||[]).filter(Number.isFinite); if (any.length) mO = trimmedMedian(any); }
          if (!Number.isFinite(mU)) { const any = (mo.by.U||[]).filter(Number.isFinite); if (any.length) mU = trimmedMedian(any); }
          if (!Number.isFinite(mO) || !Number.isFinite(mU)) return null;
          const impO = 1/mO, impU = 1/mU; const s = impO+impU; if (s<=0) return null;
          return { pO: impO/s, pU: impU/s };
        })();
        if (!probs) return;
        const booksO = getBooksCount(mo,"O"), booksU = getBooksCount(mo,"U");
        const sprO = getSpread(mo,"O"),     sprU = getSpread(mo,"U");
        if (booksO >= needBooks && sprO <= sprLimit && Number.isFinite(priceMedian(mo,"O"))) {
          const c = buildCandidateLoose(recBase, "OU2.5", "O2.5", "Over 2.5", priceMedian(mo,"O"), probs.pO, booksO, needBooks);
          if (c) { const prev = fillerByFixture.get(fx.fixture_id); if (!prev || c._ev > prev._ev) fillerByFixture.set(fx.fixture_id, c); }
        }
        if (booksU >= needBooks && sprU <= sprLimit && Number.isFinite(priceMedian(mo,"U"))) {
          const c = buildCandidateLoose(recBase, "OU2.5", "U2.5", "Under 2.5", priceMedian(mo,"U"), probs.pU, booksU, needBooks);
          if (c) { const prev = fillerByFixture.get(fx.fixture_id); if (!prev || c._ev > prev._ev) fillerByFixture.set(fx.fixture_id, c); }
        }
      })();

      (function makeLooseHTFT(){
        const needBooks = MIN_BOOKS_RELAX;
        const sprLimit = 0.70;
        const keys = ["HH","HD","HA","DH","DD","DA","AH","AD","AA"];
        const labels = { HH:"Home/Home", HD:"Home/Draw", HA:"Home/Away", DH:"Draw/Home", DD:"Draw/Draw", DA:"Draw/Away", AH:"Away/Home", AD:"Away/Draw", AA:"Away/Away" };
        const approxProb = { HH: 0.34, HD: 0.11, HA: 0.06, DH: 0.13, DD: 0.14, DA: 0.08, AH: 0.06, AD: 0.08, AA: 0.10 };
        for (const k of keys) {
          const price = priceMedian(mh,k); if (!Number.isFinite(price)) continue;
          const books = getBooksCount(mh,k);
          const spr = getSpread(mh,k);
          if (books < needBooks || spr > sprLimit) continue;
          const prob = approxProb[k] ?? 0.05;
          const c = buildCandidateLoose(recBase, "HT-FT", k, labels[k]||k, price, prob, books, needBooks);
          if (c) { const prev = fillerByFixture.get(fx.fixture_id); if (!prev || c._ev > prev._ev) fillerByFixture.set(fx.fixture_id, c); }
        }
      })();
    }

    // rang + preseci
    const sorted = bestPerFixture.sort((a,b)=> ((b._ev_lb ?? b._ev) - (a._ev_lb ?? a._ev)) || (b.confidence_pct - a.confidence_pct));
    const pickedIds = new Set(sorted.map(x => x.fixture_id));

    // fill-to-limit: popuni do TARGET (dinamički: 6/15/20)
    const fillers = Array.from(fillerByFixture.values())
      .filter(c => c && !pickedIds.has(c.fixture_id))
      .sort((a,b)=> (b._ev - a._ev) || (b.confidence_pct - a.confidence_pct));

    while (sorted.length < TARGET && fillers.length) {
      sorted.push(fillers.shift());
    }

    // upis u KV (slim = TARGET, full = do 100, ali >= TARGET)
    const keySlim = `vbl:${ymd}:${slotQ}`;
    const keyFull = `vbl_full:${ymd}:${slotQ}`;
    const payloadSlim = { items: sorted.slice(0, TARGET), at: new Date().toISOString(), ymd, slot: slotQ };
    const payloadFull = { items: sorted.slice(0, Math.max(TARGET, Math.min(sorted.length, 100))), at: new Date().toISOString(), ymd, slot: slotQ };
    await kvSetJSON(keySlim, payloadSlim);
    await kvSetJSON(keyFull, payloadFull);

    // dnevni union (za learning settle) — koristi slim listu (TARGET)
    const unionKey = `vb:day:${ymd}:union`;
    await kvSetJSON(unionKey, payloadSlim.items);

    // ⬇️ DODATO: napiši i "last" koji tvoji workflow-i očekuju (pointer u debug-u)
    const lastKey = `vb:day:${ymd}:last`;
    await kvSetJSON(lastKey, payloadSlim.items);

    return res.status(200).json({
      ok:true, slot:slotQ, ymd,
      count: payloadSlim.items.length, count_full: payloadFull.items.length, wrote:true,
      football: payloadSlim.items
    });

  } catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
