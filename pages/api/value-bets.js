// pages/api/value-bets.js
// Filtrirani value-bets (ban lige i TIMOVA, one-per-fixture, cap po ligi, limit).
// Podržava "trusted-only"; po difoltu dozvoljava aggregate fallback samo ako nema named/trusted,
// ali možeš da GA UGASIŠ parametrom ?no_aggregate=1 (npr. za Football tab).

export const config = { api: { bodyParser: false } };

/* =================== ENV & CONST =================== */
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
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

// Filteri
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.30);
const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";
const VB_LIMIT = clampInt(process.env.VB_LIMIT, 15, 1, 50);
const VB_MAX_PER_LEAGUE = clampInt(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);

// Dozvoljeni marketi
const ALLOWED_MARKETS_DEFAULT = "1X2,Match Winner";

// Širi default ban regex (liga, država, TIMOVI)
const BAN_DEFAULT =
  "(Women|Womens|Girls|Fem|U1[0-9]|U2[0-9]|U-?1[0-9]|U-?2[0-9]|Under-?\\d+|Reserve|Reserves|B Team|B-Team|II|Youth|Academy|Development|Premier League 2|PL2|Friendly|Friendlies|Club Friendly|Test|Trial)";

const BAN_LEAGUES_RE = safeRegex(process.env.BAN_LEAGUES || BAN_DEFAULT);

/* =================== HANDLER =================== */
export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd  || "") || ymdInTZ(new Date(), TZ));

    // Query overrides
    const qpMin          = req.query?.min_odds ? Number(req.query.min_odds) : null;
    const qpTrusted      = req.query?.trusted != null ? String(req.query.trusted) : null;
    const qpMk           = req.query?.markets ? String(req.query.markets) : null;
    const qpLimit        = req.query?.limit ? clampInt(req.query.limit, VB_LIMIT, 1, 50) : VB_LIMIT;
    const qpMaxPerLeague = req.query?.max_per_league ? clampInt(req.query.max_per_league, VB_MAX_PER_LEAGUE, 1, 10) : VB_MAX_PER_LEAGUE;
    const qpBan          = req.query?.ban ? safeRegex(String(req.query.ban)) : BAN_LEAGUES_RE;
    const noAggregate    = String(req.query?.no_aggregate || "0") === "1";

    const minOdds     = Number.isFinite(qpMin) ? qpMin : MIN_ODDS;
    const trustedOnly = qpTrusted === "1" ? true : qpTrusted === "0" ? false : TRUSTED_ONLY;
    const marketsUpper = (qpMk ? qpMk : ALLOWED_MARKETS_DEFAULT)
      .split(",")
      .map((s) => s.trim().toUpperCase());

    // 1) Fixtures (slot window)
    const fixtures = await fetchFixturesAF(ymd, TZ);
    let slotFixtures = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));

    // 1a) BAN po ligi, državi I TIMOVIMA (home/away)
    if (qpBan) {
      slotFixtures = slotFixtures.filter((fx) => {
        const league   = (fx?.league?.name || "").toString();
        const country  = (fx?.league?.country || "").toString();
        const homeName = (fx?.teams?.home?.name || "").toString();
        const awayName = (fx?.teams?.away?.name || "").toString();
        // ako regex pogodi bilo šta od ovoga — BAN
        if (qpBan.test(league))   return false;
        if (qpBan.test(country))  return false;
        if (qpBan.test(homeName)) return false;
        if (qpBan.test(awayName)) return false;
        return true;
      });
    }

    if (!slotFixtures.length) {
      return res.status(200).json({ ok: true, disabled: false, slot, value_bets: [], source: "fixtures-empty" });
    }

    // 2) Join sa kvotama (KV/Upstash)
    const perFixtureBest = [];
    for (const fx of slotFixtures) {
      const fid = getFID(fx);
      if (!fid) continue;

      const raw = await kvGetFirst(candidateOddsKeys(ymd, fid));
      const oddsObj = parseOddsValue(raw);
      if (!oddsObj) continue;

      // 3) kandidati
      const candAll = extractPicks(oddsObj, marketsUpper);

      // trusted-only logika:
      //  - prvo uzmi named/trusted
      //  - ako ih nema: ako je noAggregate=0, dozvoli aggregate fallback; ako je 1, ostavi prazno
      let cand = candAll;
      if (trustedOnly) {
        const namedTrusted = candAll.filter((p) => p.trusted && p.bookmaker && p.bookmaker !== "aggregate");
        if (namedTrusted.length) {
          cand = namedTrusted;
        } else {
          cand = noAggregate ? [] : candAll.filter((p) => p.bookmaker === "aggregate" && p.trusted);
        }
      } else if (noAggregate) {
        // čak i u non-trusted režimu možeš isključiti aggregate
        cand = candAll.filter((p) => p.bookmaker && p.bookmaker !== "aggregate");
      }

      // 4) min od
      const filtered = cand.filter((p) => Number(p.price || p.odds) >= minOdds);
      if (!filtered.length) continue;

      // 5) one-per-fixture
      const best = pickBestForFixture(filtered);
      if (!best) continue;

      perFixtureBest.push(toTicket(best, fx));
    }

    if (!perFixtureBest.length) {
      return res.status(200).json({ ok: true, disabled: false, slot, value_bets: [], source: "fixtures-only(no-odds>=min)" });
    }

    // 6) sort
    perFixtureBest.sort((a, b) => {
      const c = Number(b.confidence_pct || 0) - Number(a.confidence_pct || 0);
      if (c !== 0) return c;
      const ta = Date.parse(getKOISO(a) || "") || 0;
      const tb = Date.parse(getKOISO(b) || "") || 0;
      return ta - tb;
    });

    // 7) cap po ligi + limit
    const capped = [];
    const leagueCount = new Map();
    for (const t of perFixtureBest) {
      const leagueKey = (t?.league?.country ? `${t.league.country}|` : "") + (t?.league?.name || "");
      const cur = leagueCount.get(leagueKey) || 0;
      if (cur >= qpMaxPerLeague) continue;
      leagueCount.set(leagueKey, cur + 1);
      capped.push(t);
      if (capped.length >= qpLimit) break;
    }

    return res.status(200).json({
      ok: true,
      disabled: false,
      slot,
      value_bets: capped.slice(0, qpLimit),
      source: "fixtures+odds(cache)+filtered",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* =================== API-FOOTBALL =================== */

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

/* =================== ODDS LOOKUP =================== */
function candidateOddsKeys(ymd, fid) {
  return [
    `odds:fixture:${ymd}:${fid}`,
    `odds:${ymd}:${fid}`,
    `odds:fixture:${fid}`,
    `odds:${fid}`,
  ];
}
async function kvGetFirst(keys) { for (const k of keys) { const v = await kvGet(k); if (v != null) return v; } return null; }
async function kvGet(key) {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store" });
      if (r.ok) { const j = await r.json().catch(() => null); if (j && j.result != null) return j.result; }
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, cache: "no-store" });
      if (r.ok) { const j = await r.json().catch(() => null); if (j && j.result != null) return j.result; }
    } catch {}
  }
  return null;
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
    if (v.match_winner && typeof v.match_winner === "object") {
      const mw = v.match_winner || {};
      return { __kind: "MW_SUMMARY", home: numOrNull(mw.home), draw: numOrNull(mw.draw), away: numOrNull(mw.away) };
    }
    if (Array.isArray(v.bookmakers)) return v;
    if (Array.isArray(v)) return v;
    return null;
  } catch { return null; }
}

/* =================== EXTRACT PICKS =================== */
function extractPicks(odds, marketsUpper) {
  // A) Sažeti 1X2 — tretiraj kao trusted fallback sa "aggregate" bookmaker-om
  if (odds && odds.__kind === "MW_SUMMARY") {
    const out = [];
    const pushIf = (selection, price) => {
      const n = Number(price);
      if (Number.isFinite(n)) out.push({ market: "Match Winner", selection, price: n, bookmaker: "aggregate", trusted: true });
    };
    pushIf("Home", odds.home); pushIf("Draw", odds.draw); pushIf("Away", odds.away);
    return out;
  }

  const picks = [];

  // B) Normalizovan niz
  if (Array.isArray(odds)) {
    for (const o of odds) {
      const m = String(o?.market || o?.name || "").toUpperCase();
      if (!marketsUpper.some((mw) => m.includes(mw))) continue;
      const sel = o?.selection || o?.value || o?.outcome || "";
      const price = Number(o?.price ?? o?.odd ?? o?.odds);
      if (!Number.isFinite(price)) continue;
      const bookmaker = o?.bookmaker || o?.bk || null;
      const trusted = o?.trusted || isTrusted(bookmaker);
      picks.push({ market: o?.market || o?.name || m, selection: sel, price, bookmaker, trusted });
    }
    return coalesce(picks);
  }

  // C) API-Sports
  const bks = Array.isArray(odds?.bookmakers) ? odds.bookmakers : [];
  for (const bk of bks) {
    const bets = Array.isArray(bk?.bets) ? bk.bets : Array.isArray(bk?.markets) ? bk.markets : [];
    for (const bet of bets) {
      const m = String(bet?.name || bet?.market || "").toUpperCase();
      if (!marketsUpper.some((mw) => m.includes(mw))) continue;
      const values = Array.isArray(bet?.values) ? bet.values : Array.isArray(bet?.outcomes) ? bet.outcomes : [];
      for (const v of values) {
        const sel = v?.value || v?.selection || v?.name || "";
        const price = Number(v?.odd || v?.price || v?.decimal);
        if (!Number.isFinite(price)) continue;
        const bookmaker = bk?.name || null;
        const trusted = isTrusted(bookmaker);
        picks.push({ market: bet?.name || bet?.market || m, selection: sel, price, bookmaker, trusted });
      }
    }
  }
  return coalesce(picks);
}

function isTrusted(name) {
  if (!name) return false;
  const list = (process.env.TRUSTED_BOOKMAKERS || process.env.TRUSTED_BOOKIES || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  return list.includes(String(name).toLowerCase());
}

function coalesce(picks) {
  const out = []; const map = new Map();
  for (const p of picks) {
    if (!Number.isFinite(p.price)) continue;
    const key = `${String(p.market).toUpperCase()}|${String(p.selection).toUpperCase()}`;
    const cur = map.get(key);
    if (!cur || p.price > cur.price) map.set(key, p);
  }
  map.forEach((v) => out.push(v));
  return out;
}

function pickBestForFixture(arr) {
  if (!arr || !arr.length) return null;
  let best = null, bestScore = -1e9;
  for (const p of arr) {
    const conf = confidenceFromPrice(p.price, p.bookmaker === "aggregate");
    const namedTrusted     = p.trusted && p.bookmaker && p.bookmaker !== "aggregate";
    const aggregateTrusted = p.trusted && p.bookmaker === "aggregate";
    const score = (namedTrusted ? 2000 : aggregateTrusted ? 1000 : 0) + conf + (Number(p.price) * 0.01);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/* =================== MAP TO UI =================== */
function confidenceFromPrice(price, isAggregate = false) {
  const p = Number(price || 0);
  if (!Number.isFinite(p) || p <= 1.0) return 50;
  const cap = isAggregate ? 68 : 85; // agregatne kvote plafon ~68
  const base = 50 + Math.min(cap - 50, (p - 1.30) * 18);
  return Math.round(Math.max(50, Math.min(cap, base)));
}

function toTicket(p, fx) {
  const conf = confidenceFromPrice(p.price, p.bookmaker === "aggregate");
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
    market_label: p.market,
    market: p.market,
    selection: p.selection,
    market_odds: p.price,
    odds: p.price,
    bookmaker: p.bookmaker || null,
    confidence_pct: conf,
    explain: { bullets: [p.bookmaker ? `source: ${p.bookmaker}` : "source: aggregated"] },
    fixture_id: getFID(fx),
  };
}

/* =================== SLOT & TIME =================== */
function normalizeSlot(s) { const x = String(s || "").toLowerCase(); return ["am","pm","late"].includes(x) ? x : "pm"; }
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
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }

/* =================== UTILS =================== */
function clampInt(v, defVal, min, max) { const n = Number(v); if (!Number.isFinite(n)) return defVal; return Math.max(min, Math.min(max, Math.floor(n))); }
function safeRegex(src) { try { if (!src) return null; return new RegExp(src, "i"); } catch { return null; } }
function numOrNull(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
