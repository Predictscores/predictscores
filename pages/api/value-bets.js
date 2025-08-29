// pages/api/value-bets.js
// NAMED-ONLY value bets (bez agregata) sa konsenzus logikom preko više bukija.
// - Konsenzus i spread se računaju preko TRUSTED bukija (ako ih ima ≥2), inače preko svih.
// - Uplift cap (TRUSTED_UPLIFT_CAP) ograničava koliko "bolja" kvota od konsenzusa
//   ulazi u računanje confidence-a (štiti od outliera).
// - ONE_TRUSTED_TOL: ako postoji tačno 1 trusted, traži potvrdu još jednog bukija
//   u +-tol; inače se selekcija odbacuje.
// - Filteri: ban (lige/timovi), min_odds, max_per_league, limit.
// - markets: 1X2 / "Match Winner" (drugi marketi ignorisani).
//
// Ovaj endpoint BIRА 1 tiket po meču: "najbolja" selekcija po skoru/confidence.
// Izvor kvota: odds:<YMD>:<fixtureId> (raw named odds sa bookmakers/bets/values)

export const config = { api: { bodyParser: false } };

/* ================= ENV & CONSTS ================= */

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football fixtures
const AF_BASE =
  (process.env.API_FOOTBALL_BASE_URL || "").trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  (process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "").trim();

// Storage
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Pragovi (brojevi!)
const TRUSTED_SPREAD_MAX = numEnv(process.env.TRUSTED_SPREAD_MAX, 0.12);
const TRUSTED_UPLIFT_CAP = numEnv(process.env.TRUSTED_UPLIFT_CAP, 0.08);
const ALL_SPREAD_MAX     = numEnv(process.env.ALL_SPREAD_MAX,     0.12);
const ONE_TRUSTED_TOL    = numEnv(process.env.ONE_TRUSTED_TOL,    0.05);

// Ostalo
const MIN_ODDS_DEFAULT     = numEnv(process.env.MIN_ODDS, 1.30);
const VB_LIMIT_DEFAULT     = intEnv(process.env.VB_LIMIT, 15, 1, 50);
const VB_MAX_PER_LEAGUE_DF = intEnv(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);
const TRUSTED_ONLY_DEFAULT = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";

// Ban regex (liga, zemlja, timovi)
const BAN_DEFAULT =
  "(Women|Womens|Girls|Fem|U1[0-9]|U2[0-9]|U-?1[0-9]|U-?2[0-9]|Under-?\\d+|Reserve|Reserves|B Team|B-Team|II|Youth|Academy|Development|Premier League 2|PL2|Friendly|Friendlies|Club Friendly|Test|Trial)";

/* ================= HANDLER ================= */

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd  || "") || ymdInTZ(new Date(), TZ));

    const minOdds       = req.query?.min_odds ? Number(req.query.min_odds) : MIN_ODDS_DEFAULT;
    const limit         = req.query?.limit ? intEnv(req.query.limit, VB_LIMIT_DEFAULT, 1, 50) : VB_LIMIT_DEFAULT;
    const maxPerLeague  = req.query?.max_per_league ? intEnv(req.query.max_per_league, VB_MAX_PER_LEAGUE_DF, 1, 10) : VB_MAX_PER_LEAGUE_DF;
    const trustedOnly   = req.query?.trusted != null
      ? String(req.query.trusted) === "1"
      : TRUSTED_ONLY_DEFAULT;
    const marketsUpper  = (req.query?.markets || "1X2,Match Winner")
      .split(",").map((s) => s.trim().toUpperCase());
    const banRe         = safeRegex(req.query?.ban || process.env.BAN_LEAGUES || BAN_DEFAULT);

    // 1) Fixtures za dan i slot
    const fixtures = await fetchFixturesAF(ymd, TZ);
    let slotFixtures = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));

    // 2) BAN liga/zemlja/tim
    if (banRe) {
      slotFixtures = slotFixtures.filter((fx) => {
        const lg = String(fx?.league?.name || "");
        const co = String(fx?.league?.country || "");
        const h  = String(fx?.teams?.home?.name || "");
        const a  = String(fx?.teams?.away?.name || "");
        if (banRe.test(lg)) return false;
        if (banRe.test(co)) return false;
        if (banRe.test(h))  return false;
        if (banRe.test(a))  return false;
        return true;
      });
    }

    if (!slotFixtures.length) {
      return res.status(200).json({ ok: true, disabled: false, slot, value_bets: [], source: "fixtures-empty" });
    }

    const out = [];
    for (const fx of slotFixtures) {
      const fid = getFID(fx);
      if (!fid) continue;

      // 3) učitaj raw odds object (bookmakers/bets/values) — NAMED ONLY
      const raw = await kvGetFirst(candidateOddsKeys(ymd, fid));
      const oddsObj = parseOddsValue(raw);
      if (!oddsObj || !Array.isArray(oddsObj.bookmakers) || !oddsObj.bookmakers.length) {
        continue; // nema named — preskoči (bez agregata)
      }

      // 4) Izdvoji kvote po selekcijama (Home/Draw/Away) za 1X2/Match Winner
      const selMap = collectSelections(oddsObj, marketsUpper);

      // 5) Za svaku selekciju izračunaj konsenzus/spread/score i predloži najbolju ponudu
      const picks = [];
      for (const sel of ["Home", "Draw", "Away"]) {
        const prices = selMap.get(sel);
        if (!prices || !prices.length) continue;

        const trustedList = getTrustedList();         // lower-case keys
        const trusted = prices.filter(p => p.trusted);
        const all      = prices.slice();

        // odredi konsenzus i spread
        let consensus = null, spread = null, nUsed = 0, usedTrusted = false;

        if (trusted.length >= 2) {
          const vals = trusted.map(p => p.price).filter(Number.isFinite);
          if (vals.length >= 2) {
            consensus = median(vals);
            const max = Math.max(...vals), min = Math.min(...vals);
            spread = (max - min) / (consensus || 1);
            usedTrusted = true;
            nUsed = vals.length;
            if (spread > TRUSTED_SPREAD_MAX) continue; // previše neslaganja među trusted
          }
        }

        if (consensus == null) {
          // Ako nema 2 trusted, probaj "all"
          const valsAll = all.map(p => p.price).filter(Number.isFinite);
          if (valsAll.length >= 2) {
            consensus = median(valsAll);
            const max = Math.max(...valsAll), min = Math.min(...valsAll);
            spread = (max - min) / (consensus || 1);
            nUsed = valsAll.length;
            usedTrusted = false;
            if (spread > ALL_SPREAD_MAX) continue; // previše neslaganja generalno
          }
        }

        // Poseban slučaj: tačno 1 trusted → traži potvrdu ± ONE_TRUSTED_TOL
        if (consensus == null && trusted.length === 1) {
          const t = trusted[0];
          const ok = all.some(p => Math.abs(p.price - t.price) / (t.price || 1) <= ONE_TRUSTED_TOL);
          if (!ok) continue;
          consensus = t.price;
          spread = 0.0;
          nUsed = 2;
          usedTrusted = true;
        }

        if (consensus == null) continue;

        // izaberi najbolju kvotu/izvor (prioritet: trusted ako tražimo trustedOnly)
        let pool = trustedOnly ? trusted : (trusted.length ? trusted : all);
        if (!pool.length) continue;

        const best = pool.reduce((acc, p) => (p.price > (acc?.price || -1) ? p : acc), null);
        if (!best) continue;

        // min_odds filter
        if (!Number.isFinite(best.price) || best.price < minOdds) continue;

        // Uplift cap na "effective" radi računanja confidence-a
        const eff = Math.min(best.price, consensus * (1 + TRUSTED_UPLIFT_CAP));
        const conf = confidenceFromConsensus(consensus, eff, TRUSTED_UPLIFT_CAP);

        picks.push({
          selection: sel,
          bookmaker: best.bookmaker,
          price: best.price,
          consensus,
          spread,
          n_consensus: nUsed,
          used_trusted: usedTrusted,
          confidence: conf,
        });
      }

      if (!picks.length) continue;

      // Izaberi najbolju selekciju u meču (po confidence, pa po ceni)
      picks.sort((a, b) => {
        const c = b.confidence - a.confidence;
        if (c !== 0) return c;
        return b.price - a.price;
      });
      const top = picks[0];
      out.push(toTicket(top, fx));
    }

    if (!out.length) {
      return res.status(200).json({ ok: true, disabled: false, slot, value_bets: [], source: "named-only(no-pass)" });
    }

    // Sort: confidence desc, pa kickoff asc
    out.sort((a, b) => {
      const c = Number(b.confidence_pct || 0) - Number(a.confidence_pct || 0);
      if (c !== 0) return c;
      const ta = Date.parse(getKOISO(a) || "") || 0;
      const tb = Date.parse(getKOISO(b) || "") || 0;
      return ta - tb;
    });

    // Cap po ligi + ukupni limit
    const capped = [];
    const leagueCount = new Map();
    for (const t of out) {
      const leagueKey = (t?.league?.country ? `${t.league.country}|` : "") + (t?.league?.name || "");
      const cur = leagueCount.get(leagueKey) || 0;
      if (cur >= maxPerLeague) continue;
      leagueCount.set(leagueKey, cur + 1);
      capped.push(t);
      if (capped.length >= limit) break;
    }

    return res.status(200).json({
      ok: true,
      disabled: false,
      slot,
      value_bets: capped,
      source: "named-only(consensus)",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ================= BUILD TICKET ================= */

function toTicket(p, fx) {
  const marketName = "Match Winner";
  const explainBullets = [
    `consensus: ${fmtOdds(p.consensus)} (n=${p.n_consensus}${p.used_trusted ? ",trusted" : ""})`,
    `source: ${p.bookmaker}`,
  ];
  return {
    kickoff: getKOISO(fx),
    datetime_local: { date_time: getKOISO(fx) },
    league: {
      id: fx?.league?.id ?? null,
      name: fx?.league?.name ?? "",
      country: fx?.league?.country ?? "",
    },
    teams: {
      home: { name: fx?.teams?.home?.name ?? "" },
      away: { name: fx?.teams?.away?.name ?? "" },
    },
    market_label: marketName,
    market: marketName,
    selection: p.selection,
    market_odds: p.price,
    odds: p.price,
    bookmaker: p.bookmaker || null,
    confidence_pct: Math.round(p.confidence),
    explain: { bullets: explainBullets },
    fixture_id: getFID(fx),
  };
}

/* ================= CONSENSUS & PICK HELPERS ================= */

function collectSelections(oddsObj, marketsUpper) {
  // Vrati Map<"Home"|"Draw"|"Away", Array<{bookmaker, price, trusted}>>
  const map = new Map([["Home", []], ["Draw", []], ["Away", []]]);
  const trustedSet = new Set(getTrustedList());

  const bks = Array.isArray(oddsObj?.bookmakers) ? oddsObj.bookmakers : [];
  for (const bk of bks) {
    const rawName = String(bk?.name || "").trim();
    const name = rawName.toLowerCase();
    const isTrusted = trustedSet.has(name);

    // API-Football: bets[]; The Odds API (mapirano) takođe u bets[]
    const bets = Array.isArray(bk?.bets) ? bk.bets
      : (Array.isArray(bk?.markets) ? bk.markets : []);
    for (const bet of bets) {
      const m = String(bet?.name || bet?.market || "").toUpperCase();
      if (!marketsUpper.some((mw) => m.includes(mw))) continue;

      const values = Array.isArray(bet?.values) ? bet.values
        : (Array.isArray(bet?.outcomes) ? bet.outcomes : []);

      for (const v of values) {
        const sel = normalizeSelection(v?.value || v?.selection || v?.name || "");
        const price = Number(v?.odd || v?.price || v?.decimal || v?.odds);
        if (!sel || !Number.isFinite(price)) continue;
        const arr = map.get(sel);
        arr.push({ bookmaker: displayBookmaker(rawName), price, trusted: isTrusted });
      }
    }
  }
  return map;
}

function normalizeSelection(s) {
  const x = String(s || "").toLowerCase().trim();
  if (!x) return null;
  if (x === "home" || x === "1" || /home|^1$/.test(x)) return "Home";
  if (x === "draw" || x === "x" || /draw|^x$/.test(x)) return "Draw";
  if (x === "away" || x === "2" || /away|^2$/.test(x)) return "Away";
  // ponekad Odds API vrati nazive timova → mapiramo na Home/Away:
  if (/^team1|home team|team home/i.test(s)) return "Home";
  if (/^team2|away team|team away/i.test(s)) return "Away";
  if (/tie|remi/i.test(s)) return "Draw";
  return null;
}

function displayBookmaker(raw) {
  // Lepši prikaz poznatih ključeva (Odds API keys -> "lijepo ime")
  const r = String(raw || "").trim();
  const k = r.toLowerCase();
  const map = {
    "williamhill": "William Hill",
    "betfair-exchange": "Betfair Exchange",
    "bet365": "Bet365",
    "pinnacle": "Pinnacle",
    "unibet": "Unibet",
    "bwin": "Bwin",
    "marathonbet": "Marathonbet",
    "1xbet": "1xBet",
    "888sport": "888sport",
    "ladbrokes": "Ladbrokes",
    "betway": "Betway",
    "betsson": "Betsson",
    "10bet": "10bet",
    "sportingbet": "Sportingbet",
  };
  return map[k] || r || "unknown";
}

function confidenceFromConsensus(consensus, effectivePrice, cap) {
  // Konsenzus -> efektivna kvota posle cap-a; mapiraj uplift u [55..85]
  const c = Number(consensus || 0);
  const e = Number(effectivePrice || 0);
  if (!Number.isFinite(c) || !Number.isFinite(e) || c <= 1.0 || e <= c) return 55;
  const uplift = Math.min((e / c) - 1, Math.max(0.02, cap || 0.08)); // osiguraj >0
  const score = 55 + (uplift / (cap || 0.08)) * 30; // 55..85
  return Math.max(55, Math.min(85, score));
}

/* ================= IO / FETCH ================= */

async function fetchFixturesAF(ymd, tz) {
  try {
    const url = `${AF_BASE.replace(/\/+$/, "")}/fixtures?date=${encodeURIComponent(ymd)}&timezone=${encodeURIComponent(tz)}`;
    const r = await fetch(url, {
      headers: { "x-apisports-key": AF_KEY, accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j?.response) ? j.response : Array.isArray(j) ? j : [];
    return arr.map(normalizeAF);
  } catch {
    return [];
  }
}

function normalizeAF(x) {
  const fx = x?.fixture || {};
  const lg = x?.league || {};
  const tm = x?.teams || {};
  return {
    fixture: { id: fx.id ?? x?.id ?? null, date: fx.date ?? x?.date ?? null },
    league:  { id: lg.id ?? null, name: lg.name ?? "", country: lg.country ?? "" },
    teams:   {
      home: { name: tm?.home?.name ?? x?.home?.name ?? x?.home ?? "" },
      away: { name: tm?.away?.name ?? x?.away?.name ?? x?.away ?? "" },
    },
  };
}

function getFID(fx) { return fx?.fixture?.id ?? fx?.id ?? null; }
function getKOISO(fx) {
  const raw = fx?.fixture?.date || fx?.datetime_local?.starting_at?.date_time || fx?.datetime_local?.date_time || fx?.kickoff || null;
  if (!raw) return null;
  return String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
}

function candidateOddsKeys(ymd, fid) {
  return [
    `odds:${ymd}:${fid}`,
    `odds:fixture:${ymd}:${fid}`,
    `odds:${fid}`,
    `odds:fixture:${fid}`,
  ];
}
async function kvGetFirst(keys) {
  for (const k of keys) {
    const v = await kvGet(k);
    if (v != null) return v;
  }
  return null;
}
async function kvGet(key) {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && "result" in j) return j.result;
      }
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && "result" in j) return j.result;
      }
    } catch {}
  }
  return null;
}

/* ================= UTILS ================= */

function getTrustedList() {
  return (process.env.TRUSTED_BOOKMAKERS || process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  const m = Math.floor(n / 2);
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function fmtOdds(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x ?? "");
  return n.toFixed(n >= 10 ? 2 : 2);
}
function normalizeSlot(s) {
  const x = String(s || "").toLowerCase();
  return ["am", "pm", "late"].includes(x) ? x : "pm";
}
function inSlotWindow(iso, tz, slot) {
  if (!iso) return false;
  const d = new Date(iso);
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(d));
  if (slot === "late") return h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  return h >= 15 && h <= 23;
}
function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}
function intEnv(v, defVal, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function numEnv(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}
function safeRegex(src) {
  try { if (!src) return null; return new RegExp(src, "i"); } catch { return null; }
}
function parseOddsValue(v) {
  try {
    if (v == null) return null;
    if (typeof v === "string") return parseOddsValue(JSON.parse(v));
    if (typeof v !== "object") return null;
    if (v.value   != null) return parseOddsValue(v.value);
    if (v.odds    != null) return parseOddsValue(v.odds);
    if (v.data    != null) return parseOddsValue(v.data);
    if (v.payload != null) return parseOddsValue(v.payload);
    if (Array.isArray(v.bookmakers)) return v;   // očekivani oblik
    return null;
  } catch { return null; }
  }
