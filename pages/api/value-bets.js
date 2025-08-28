// pages/api/value-bets.js
// Spaja fixtures (API-Football) sa kvotama iz KV/Upstash (odds:* ključevi) i vraća "value bets" listu.

export const config = { api: { bodyParser: false } };

/* =================== ENV & CONST =================== */
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
const AF_BASE =
  (process.env.API_FOOTBALL_BASE_URL || "").trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  (process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "").trim();

// Storage (oba su opciona; imamo ispravan fallback)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Filteri
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.30);
const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "0") === "1";

// Široko pokrivamo nazive marketa iz različitih izvora
const ALLOWED_MARKETS = (
  process.env.ALLOWED_MARKETS ||
  "1X2,Match Winner,BTTS,Both Teams to Score,OU 2.5,Over/Under,HT-FT,HT/FT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase());

/* =================== HANDLER =================== */
export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "am"));
    const ymd = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    // Query overrides (za test bez menjanja ENV)
    const qpMin = req.query?.min_odds ? Number(req.query.min_odds) : null;
    const qpTrusted = req.query?.trusted != null ? String(req.query.trusted) : null;
    const qpMk = req.query?.markets ? String(req.query.markets) : null;

    const minOdds = Number.isFinite(qpMin) ? qpMin : MIN_ODDS;
    const trustedOnly = qpTrusted === "1" ? true : qpTrusted === "0" ? false : TRUSTED_ONLY;
    const markets = (qpMk ? qpMk : ALLOWED_MARKETS.join(","))
      .split(",")
      .map((s) => s.trim().toUpperCase());

    // 1) Fixtures za dan i slot
    const fixtures = await fetchFixturesAF(ymd, TZ);
    const slotFixtures = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));

    if (!slotFixtures.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-empty",
      });
    }

    // 2) Za svaki fixture, probaj više mogućih ključeva dok ne nađeš odds
    const picks = [];
    for (const fx of slotFixtures) {
      const fid = getFID(fx);
      if (!fid) continue;

      const candKeys = candidateOddsKeys(ymd, fid);
      const raw = await kvGetFirst(candKeys);
      const odds = parseOddsValue(raw);
      if (!odds) continue;

      // 3) Izvuci tikete iz kvota, filtriraj i mapiraj
      const cand = extractPicksFromOdds(odds, markets, trustedOnly);
      const filtered = cand.filter((p) => Number(p.price || p.odds) >= minOdds);

      for (const p of filtered) picks.push(toTicket(p, fx));
    }

    if (!picks.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-only(no-odds>=min)",
      });
    }

    // Sort: confidence desc, pa kickoff asc
    picks.sort((a, b) => {
      const c = Number(b.confidence_pct || 0) - Number(a.confidence_pct || 0);
      if (c !== 0) return c;
      const ta = Date.parse(getKOISO(a) || "") || 0;
      const tb = Date.parse(getKOISO(b) || "") || 0;
      return ta - tb;
    });

    return res.status(200).json({
      ok: true,
      disabled: false,
      slot,
      value_bets: picks,
      source: "fixtures+odds(cache)",
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

// Probaj više mogućih šema ključa — writer ponekad koristi drugačiji prefiks
function candidateOddsKeys(ymd, fid) {
  return [
    `odds:fixture:${ymd}:${fid}`,
    `odds:${ymd}:${fid}`,
    `odds:fixture:${fid}`,
    `odds:${fid}`,
  ];
}

// Vrati prvu pronađenu vrednost među kandidatima
async function kvGetFirst(keys) {
  for (const k of keys) {
    const v = await kvGet(k);
    if (v != null) return v;
  }
  return null;
}

// SINGLE GET sa ispravnim fallback-om (KV pa Upstash, ali samo ako ima vrednost)
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
        if (j && j.result != null) return j.result; // vrati samo ako postoji vrednost
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

    // String → JSON
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      return parseOddsValue(JSON.parse(s)); // rekurzivno jer često je string od {value:"[...]"}
    }

    // Već je objekat
    if (Array.isArray(v)) return v; // normalizovan niz kvota
    if (typeof v === "object") {
      // Najčešći wrapperi
      if (v.value != null) return parseOddsValue(v.value);
      if (v.odds != null) return parseOddsValue(v.odds);
      if (v.data != null) return parseOddsValue(v.data);
      if (v.payload != null) return parseOddsValue(v.payload);

      // Direktno iz API-Sports formata
      if (Array.isArray(v.bookmakers)) return v;

      // Ako ništa od navedenog — nepoznat format
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/* =================== EXTRACT PICKS =================== */

// Izvuci kandidate iz odds objekta; podržava i API-Sports i normalizovan niz
function extractPicksFromOdds(odds, marketsWantedUpper, trustedOnly) {
  const picks = [];

  // Normalizovan niz
  if (Array.isArray(odds)) {
    for (const o of odds) {
      const m = String(o?.market || o?.name || "").toUpperCase();
      if (!marketsWantedUpper.some((mw) => m.includes(mw))) continue;
      const sel = o?.selection || o?.value || o?.outcome || "";
      const price = Number(o?.price ?? o?.odd ?? o?.odds);
      if (!Number.isFinite(price)) continue;
      const bookmaker = o?.bookmaker || o?.bk || null;
      const trusted = o?.trusted || isTrusted(bookmaker);
      if (trustedOnly && !trusted) continue;
      picks.push({ market: o?.market || o?.name || m, selection: sel, price, bookmaker, trusted });
    }
    return coalescePicks(picks, trustedOnly);
  }

  // API-Sports oblik
  const bks = Array.isArray(odds?.bookmakers) ? odds.bookmakers : [];
  for (const bk of bks) {
    const bets = Array.isArray(bk?.bets) ? bk.bets : Array.isArray(bk?.markets) ? bk.markets : [];
    for (const bet of bets) {
      const m = String(bet?.name || bet?.market || "").toUpperCase();
      if (!marketsWantedUpper.some((mw) => m.includes(mw))) continue;
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

  return coalescePicks(picks, trustedOnly);
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
function coalescePicks(picks) {
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
