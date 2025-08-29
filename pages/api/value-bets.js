// pages/api/value-bets.js
// Spaja fixtures (API-Football) sa kvotama iz KV/Upstash i vraća filtrirane "value bets".
// Dodato: BAN_LEAGUES (regex), ONE-PICK-PER-FIXTURE, VB_MAX_PER_LEAGUE, VB_LIMIT.

export const config = { api: { bodyParser: false } };

/* =================== ENV & CONST =================== */
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
const AF_BASE =
  (process.env.API_FOOTBALL_BASE_URL || "").trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  (process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "").trim();

// Storage (oba su opciona; fallback KV→Upstash je ispravan)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Filteri
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.30);
const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "0") === "1";
const VB_LIMIT = clampInt(process.env.VB_LIMIT, 15, 1, 50);
const VB_MAX_PER_LEAGUE = clampInt(process.env.VB_MAX_PER_LEAGUE, 2, 1, 10);

// Široko pokrivamo nazive marketa iz različitih izvora
const ALLOWED_MARKETS_DEFAULT = "1X2,Match Winner,BTTS,Both Teams to Score,OU 2.5,Over/Under,HT-FT,HT/FT";

// BAN_LEAGUES regex (case-insensitive). Primer: (Women|U21|U23|Reserve|Friendlies)
const BAN_LEAGUES_RE = safeRegex(
  process.env.BAN_LEAGUES || "(Women|U21|U23|Reserve|Reserves|Friendly|Friendlies)"
);

/* =================== HANDLER =================== */
export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "am"));
    const ymd = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    // Query overrides (za test bez menjanja ENV)
    const qpMin = req.query?.min_odds ? Number(req.query.min_odds) : null;
    const qpTrusted = req.query?.trusted != null ? String(req.query.trusted) : null;
    const qpMk = req.query?.markets ? String(req.query.markets) : null;
    const qpLimit = req.query?.limit ? clampInt(req.query.limit, VB_LIMIT, 1, 50) : VB_LIMIT;
    const qpMaxPerLeague = req.query?.max_per_league ? clampInt(req.query.max_per_league, VB_MAX_PER_LEAGUE, 1, 10) : VB_MAX_PER_LEAGUE;
    const qpBan = req.query?.ban ? safeRegex(String(req.query.ban)) : BAN_LEAGUES_RE;

    const minOdds = Number.isFinite(qpMin) ? qpMin : MIN_ODDS;
    const trustedOnly = qpTrusted === "1" ? true : qpTrusted === "0" ? false : TRUSTED_ONLY;
    const marketsUpper = (qpMk ? qpMk : ALLOWED_MARKETS_DEFAULT)
      .split(",")
      .map((s) => s.trim().toUpperCase());

    // 1) Fixtures za dan i slot
    const fixtures = await fetchFixturesAF(ymd, TZ);
    let slotFixtures = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));

    // 1a) BAN liga/country
    if (qpBan) {
      slotFixtures = slotFixtures.filter((fx) => {
        const name = (fx?.league?.name || "").toString();
        const country = (fx?.league?.country || "").toString();
        return !(qpBan.test(name) || qpBan.test(country));
      });
    }

    if (!slotFixtures.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-empty",
      });
    }

    // 2) Uparavanje po fixture.id → odds iz KV/Upstash (više mogućih ključeva)
    const perFixtureBest = []; // ONE-PICK-PER-FIXTURE
    for (const fx of slotFixtures) {
      const fid = getFID(fx);
      if (!fid) continue;

      const raw = await kvGetFirst(candidateOddsKeys(ymd, fid));
      const oddsObj = parseOddsValue(raw);
      if (!oddsObj) continue;

      // 3) Ekstrakcija tiketa iz kvota (podržava i sažeti zapis iz refresh-odds)
      const cand = extractPicks(oddsObj, marketsUpper, trustedOnly);

      // 4) Filter minimalna kvota
      const filtered = cand.filter((p) => Number(p.price || p.odds) >= minOdds);
      if (!filtered.length) continue;

      // 5) ONE-PICK-PER-FIXTURE: izaberi najbolji kandidat za ovaj fixture
      const best = pickBestForFixture(filtered);
      if (!best) continue;

      perFixtureBest.push(toTicket(best, fx));
    }

    if (!perFixtureBest.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-only(no-odds>=min)",
      });
    }

    // 6) Sort po kvalitetu: confidence desc, pa kickoff asc
    perFixtureBest.sort((a, b) => {
      const c = Number(b.confidence_pct || 0) - Number(a.confidence_pct || 0);
      if (c !== 0) return c;
      const ta = Date.parse(getKOISO(a) || "") || 0;
      const tb = Date.parse(getKOISO(b) || "") || 0;
      return ta - tb;
    });

    // 7) VB_MAX_PER_LEAGUE cap
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
      headers: {
        "x-apisports-key": AF_KEY,
        accept: "application/json",
      },
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
    fixture: {
      id: fx.id ?? x?.id ?? null,
      date: fx.date ?? x?.date ?? null,
    },
    league: {
      id: lg.id ?? null,
      name: lg.name ?? "",
      country: lg.country ?? "",
    },
    teams: {
      home: { name: tm?.home?.name ?? x?.home?.name ?? x?.home ?? "" },
      away: { name: tm?.away?.name ?? x?.away?.name ?? x?.away ?? "" },
    },
  };
}

function getFID(fx) {
  return fx?.fixture?.id ?? fx?.id ?? null;
}
function getKOISO(fx) {
  const raw =
    fx?.fixture?.date ||
    fx?.datetime_local?.starting_at?.date_time ||
    fx?.datetime_local?.date_time ||
    fx?.kickoff ||
    null;
  if (!raw) return null;
  return String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
}

/* =================== ODDS LOOKUP =================== */

// Probaj više mogućih šema ključa — writer može imati različit prefiks
function candidateOddsKeys(ymd, fid) {
  return [
    `odds:fixture:${ymd}:${fid}`,
    `odds:${ymd}:${fid}`,
    `odds:fixture:${fid}`,
    `odds:${fid}`,
  ];
}

// Vrati prvu pronađenu vrednost
async function kvGetFirst(keys) {
  for (const k of keys) {
    const v = await kvGet(k);
    if (v != null) return v;
  }
  return null;
}

// SINGLE GET sa ispravnim fallback-om (KV pa Upstash, vrati samo ako postoji vrednost)
async function kvGet(key) {
  // KV
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result;
      }
    } catch {}
  }
  // Upstash
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result;
      }
    } catch {}
  }
  return null;
}

// Raspakuj vrednost iz storage-a u usable objekat/niz
function parseOddsValue(v) {
  try {
    if (v == null) return null;

    // String → JSON (može biti i string od {value:"[...]"} ili sl.)
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      return parseOddsValue(JSON.parse(s));
    }
    if (typeof v !== "object") return null;

    // Najčešći wrapperi
    if (v.value != null) return parseOddsValue(v.value);
    if (v.odds  != null) return parseOddsValue(v.odds);
    if (v.data  != null) return parseOddsValue(v.data);
    if (v.payload != null) return parseOddsValue(v.payload);

    // Sažeti zapis iz refresh-odds: { match_winner:{home,draw,away}, best, fav, hits }
    if (v.match_winner && typeof v.match_winner === "object") {
      const mw = v.match_winner || {};
      return { __kind: "MW_SUMMARY", home: numOrNull(mw.home), draw: numOrNull(mw.draw), away: numOrNull(mw.away) };
    }

    // API-Sports format (bookmakers/bets/values)
    if (Array.isArray(v.bookmakers)) return v;

    // Normalizovan niz pikova
    if (Array.isArray(v)) return v;

    return null;
  } catch {
    return null;
  }
}

/* =================== EXTRACT PICKS =================== */

// Napravi kandidate iz kvota — podržan je:
//  A) Sažeti 1X2 zapis (MW_SUMMARY) iz refresh-odds
//  B) API-Sports format (bookmakers[] -> bets[] -> values[])
//  C) Normalizovan niz [{market,selection,price,bookmaker?,trusted?}]
function extractPicks(odds, marketsUpper, trustedOnly) {
  // A) Sažeti 1X2
  if (odds && odds.__kind === "MW_SUMMARY") {
    const out = [];
    const pushIf = (selection, price) => {
      const n = Number(price);
      if (Number.isFinite(n)) {
        // aggregated NEMA bookmaker → tretira se kao NOT trusted
        out.push({ market: "Match Winner", selection, price: n, bookmaker: null, trusted: false });
      }
    };
    pushIf("Home", odds.home);
    pushIf("Draw", odds.draw);
    pushIf("Away", odds.away);
    return trustedOnly ? out.filter(x => x.trusted) : out;
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
      if (trustedOnly && !trusted) continue;
      picks.push({ market: o?.market || o?.name || m, selection: sel, price, bookmaker, trusted });
    }
    return coalesce(picks);
  }

  // C) API-Sports oblik
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
        if (trustedOnly && !trusted) continue;
        picks.push({ market: bet?.name || bet?.market || m, selection: sel, price, bookmaker, trusted });
      }
    }
  }
  return coalesce(picks);
}

function isTrusted(name) {
  if (!name) return false;
  const list = (process.env.TRUSTED_BOOKMAKERS || process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  return list.includes(String(name).toLowerCase());
}

// Zadrži najbolju kvotu po (market, selection); ako je trustedOnly, već smo filtrirali
function coalesce(picks) {
  const out = [];
  const map = new Map();
  for (const p of picks) {
    if (!Number.isFinite(p.price)) continue;
    const key = `${String(p.market).toUpperCase()}|${String(p.selection).toUpperCase()}`;
    const cur = map.get(key);
    if (!cur || p.price > cur.price) map.set(key, p);
  }
  map.forEach((v) => out.push(v));
  return out;
}

// Izaberi najbolji kandidat za jedan fixture (ONE-PICK-PER-FIXTURE)
function pickBestForFixture(arr) {
  if (!arr || !arr.length) return null;
  // skor: (trusted ? +1 : 0) * 1000 + confidenceFromPrice + (price * 0.01)
  let best = null;
  let bestScore = -1e9;
  for (const p of arr) {
    const conf = confidenceFromPrice(p.price);
    const score = (p.trusted ? 1000 : 0) + conf + (Number(p.price) * 0.01);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/* =================== MAP TO UI =================== */

function confidenceFromPrice(price) {
  const p = Number(price || 0);
  if (!Number.isFinite(p) || p <= 1.0) return 50;
  const cap = 85;
  const base = 50 + Math.min(cap - 50, (p - 1.30) * 18);
  return Math.round(Math.max(50, Math.min(cap, base)));
}

function toTicket(p, fx) {
  const conf = confidenceFromPrice(p.price);
  return {
    // time
    kickoff: getKOISO(fx),
    datetime_local: { date_time: getKOISO(fx) },
    // context
    league: {
      id: fx?.league?.id ?? null,
      name: fx?.league?.name ?? "",
      country: fx?.league?.country ?? "",
    },
    teams: {
      home: { name: fx?.teams?.home?.name ?? "" },
      away: { name: fx?.teams?.away?.name ?? "" },
    },
    // market
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

function normalizeSlot(s) {
  const x = String(s || "").toLowerCase();
  return ["am", "pm", "late"].includes(x) ? x : "am";
}
function inSlotWindow(iso, tz, slot) {
  if (!iso) return false;
  const d = new Date(iso);
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(d));
  // late: 00–09:59, am: 10–14:59, pm: 15–23:59
  if (slot === "late") return h < 10;
  if (slot === "am") return h >= 10 && h < 15;
  return h >= 15 && h <= 23;
}
function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}

/* =================== UTILS =================== */

function clampInt(v, defVal, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function safeRegex(src) {
  try {
    if (!src) return null;
    return new RegExp(src, "i");
  } catch {
    return null;
  }
}
function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
                                  }
