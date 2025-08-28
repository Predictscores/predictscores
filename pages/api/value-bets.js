// pages/api/value-bets.js
// Build "value bets" spajanjem fixtures (API-Football) i kvota iz KV/Upstash ("odds:fixture:<YMD>:<fixtureId>").
// Response: { ok, disabled:false, slot, value_bets:[...], source }

export const config = { api: { bodyParser: false } };

// ---- ENV & consts ----
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
const AF_BASE =
  process.env.API_FOOTBALL_BASE_URL?.trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  process.env.API_FOOTBALL_KEY?.trim() ||
  process.env.API_FOOTBALL?.trim() ||
  "";

// Storage (oba su opciona, čita se sa proper fallback-om)
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Parametri/filteri
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.30);
const TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "0") === "1";

// Dozvoljeni marketi (široko, pokriva različite nazive)
const ALLOWED_MARKETS = (
  process.env.ALLOWED_MARKETS ||
  "1X2,Match Winner,BTTS,Both Teams to Score,OU 2.5,Over/Under,HT-FT,HT/FT"
)
  .split(",")
  .map((s) => s.trim().toUpperCase());

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "am"));
    const ymd = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    // Query param "overrides" (za ručni test bez env promena)
    const qpMin = req.query?.min_odds ? Number(req.query.min_odds) : null;
    const qpTrusted = req.query?.trusted != null ? String(req.query.trusted) : null;
    const qpMarkets = req.query?.markets ? String(req.query.markets) : null;

    const minOdds = Number.isFinite(qpMin) ? qpMin : MIN_ODDS;
    const trustedOnly = qpTrusted === "1" ? true : qpTrusted === "0" ? false : TRUSTED_ONLY;
    const markets = (qpMarkets ? qpMarkets : ALLOWED_MARKETS.join(","))
      .split(",")
      .map((s) => s.trim().toUpperCase());

    // 1) Fixtures (API-Football) za današnji dan → filtriraj u slot prozoru
    const fixtures = await fetchFixturesAF(ymd, TZ);
    const slotFixtures = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));

    // Ako nema ni fixtures — prazan dan
    if (!slotFixtures.length) {
      return res.status(200).json({
        ok: true,
        disabled: false,
        slot,
        value_bets: [],
        source: "fixtures-empty",
      });
    }

    // 2) Odds iz KV/Upstash po fixture id
    const keys = slotFixtures.map((fx) => `odds:fixture:${ymd}:${getFID(fx)}`);
    const oddsArr = await kvMGet(keys);
    const oddsByFid = new Map();
    oddsArr.forEach((raw, idx) => {
      const fid = getFID(slotFixtures[idx]);
      const parsed = parseOddsValue(raw);
      if (parsed) oddsByFid.set(fid, parsed);
    });

    // 3) Join & normalize picks
    const picks = [];
    for (const fx of slotFixtures) {
      const fid = getFID(fx);
      const odds = oddsByFid.get(fid);
      if (!odds) continue;

      // Izvuci kandidatske tikete iz kvota (samo iz dozvoljenih marketa)
      const cand = extractPicksFromOdds(odds, markets);

      // Filter: minimalna kvota, trustedOnly (ako imaš takav mark)
      const filtered = cand.filter((p) => Number(p.price || p.odds) >= minOdds);

      // Mapiraj na UI-friendly objekat
      for (const p of filtered) {
        picks.push(toTicket(p, fx));
      }
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

    // Sortiraj po confidence desc pa kickoff asc
    picks.sort((a, b) => {
      const c = Number(b.confidence_pct || 0) - Number(a.confidence_pct || 0);
      if (c !== 0) return c;
      const ta = Date.parse(getKOISO(a)) || 0;
      const tb = Date.parse(getKOISO(b)) || 0;
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

/* ==================== Fixtures (API-Football) ==================== */

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
    // Normalizuj ključna polja koja UI koristi
    return arr.map(normalizeAF);
  } catch {
    return [];
  }
}

function normalizeAF(x) {
  // API-Sports standard: { fixture:{ id, date }, league:{ id, name, country }, teams:{ home:{name}, away:{name} } }
  const fixture = x?.fixture || {};
  const league = x?.league || {};
  const teams = x?.teams || {};
  return {
    fixture: {
      id: fixture.id ?? x?.id ?? null,
      date: fixture.date ?? x?.date ?? null,
    },
    league: {
      id: league.id ?? null,
      name: league.name ?? "",
      country: league.country ?? "",
    },
    teams: {
      home: { name: teams?.home?.name ?? x?.home?.name ?? x?.home ?? "" },
      away: { name: teams?.away?.name ?? x?.away?.name ?? x?.away ?? "" },
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

/* ==================== Odds parsing & picks ==================== */

function parseOddsValue(v) {
  if (!v) return null;
  try {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      return JSON.parse(s);
    }
    if (typeof v === "object") return v;
    return null;
  } catch {
    return null;
  }
}

function extractPicksFromOdds(odds, marketsWantedUpper) {
  // Podržimo dva formata:
  //  A) API-Sports "bookmakers":[{name, bets:[{name, values:[{value,odd},...]}, ...]}]
  //  B) Normalizovan niz: [{ market, selection, price, bookmaker?, trusted? }, ...]
  const picks = [];

  if (Array.isArray(odds)) {
    for (const o of odds) {
      const m = String(o?.market || o?.name || "").toUpperCase();
      if (!marketsWantedUpper.some((mw) => m.includes(mw))) continue;
      const sel = o?.selection || o?.value || o?.outcome || "";
      const price = Number(o?.price ?? o?.odd ?? o?.odds);
      if (!Number.isFinite(price)) continue;
      picks.push({
        market: o?.market || o?.name || m,
        selection: sel,
        price,
        bookmaker: o?.bookmaker || o?.bk || null,
        trusted: !!o?.trusted,
      });
    }
    return coalesceMarkets(picks);
  }

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
        picks.push({
          market: bet?.name || bet?.market || m,
          selection: sel,
          price,
          bookmaker: bk?.name || null,
          trusted: isTrustedBookmaker(bk?.name),
        });
      }
    }
  }

  return coalesceMarkets(picks);
}

function isTrustedBookmaker(name) {
  if (!name) return false;
  const trusted = (process.env.TRUSTED_BOOKMAKERS || process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!trusted.length) return false;
  return trusted.includes(String(name).toLowerCase());
}

function coalesceMarkets(picks) {
  // Za svaki market zadrži najbolju kvotu (ili trusted ako je podešeno)
  const out = [];
  const byMarketSel = new Map();
  for (const p of picks) {
    if (!Number.isFinite(p.price)) continue;
    if (TRUSTED_ONLY && !p.trusted) continue;

    const key = `${String(p.market).toUpperCase()}|${String(p.selection).toUpperCase()}`;
    const cur = byMarketSel.get(key);
    if (!cur || p.price > cur.price) {
      byMarketSel.set(key, p);
    }
  }
  byMarketSel.forEach((v) => out.push(v));
  return out;
}

// Minimalna "confidence" metrika (sigurnosna, 50–85) na osnovu kvote
function confidenceFromPrice(price) {
  const p = Number(price || 0);
  if (!Number.isFinite(p) || p <= 1.0) return 50;
  const cap = 85;
  const base = 50 + Math.min(cap - 50, (p - 1.30) * 18); // 1.30 → 50, 2.20 → ~66, 3.50 → ~85
  return Math.round(Math.max(50, Math.min(cap, base)));
}

function toTicket(p, fx) {
  const conf = confidenceFromPrice(p.price);
  return {
    // fixture/time
    kickoff: getKOISO(fx),
    datetime_local: { date_time: getKOISO(fx) },
    // league/teams
    league: {
      id: fx?.league?.id ?? null,
      name: fx?.league?.name ?? "",
      country: fx?.league?.country ?? "",
    },
    teams: {
      home: { name: fx?.teams?.home?.name ?? "" },
      away: { name: fx?.teams?.away?.name ?? "" },
    },
    // market & pick
    market_label: p.market,
    market: p.market,
    selection: p.selection,
    market_odds: p.price,
    odds: p.price,
    bookmaker: p.bookmaker || null,
    // meta
    confidence_pct: conf,
    explain: {
      bullets: [
        p.bookmaker ? `source: ${p.bookmaker}` : "source: aggregated",
      ],
    },
    fixture_id: getFID(fx),
  };
}

/* ==================== Slot & time helpers ==================== */

function normalizeSlot(s) {
  const x = String(s || "").toLowerCase();
  return ["am", "pm", "late"].includes(x) ? x : "am";
}

function inSlotWindow(iso, tz, slot) {
  if (!iso) return false;
  const d = new Date(iso);
  const h = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(d)
  );
  // Approx policy:
  //   late: 00:00–09:59
  //   am:   10:00–14:59
  //   pm:   15:00–23:59
  if (slot === "late") return h < 10;
  if (slot === "am") return h >= 10 && h < 15;
  return h >= 15 && h <= 23;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}

/* ==================== KV helpers (FIXED fallback) ==================== */

// SINGLE GET sa ispravnim fallback-om
async function kvGet(key) {
  // Try KV first
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result; // vrati samo ako postoji
        // inače probaj Upstash
      }
    } catch {}
  }
  // Fallback: Upstash
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

// MGET/pipeline sa fallback-om: prvo KV, pa popuni praznine preko Upstash-a
async function kvMGet(keys = []) {
  const out = new Array(keys.length).fill(null);

  // 1) KV pipeline
  if (KV_URL && KV_TOKEN && keys.length) {
    try {
      const r = await fetch(`${KV_URL}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ commands: keys.map((k) => ["GET", k]) }),
      });
      if (r.ok) {
        const arr = await r.json().catch(() => null);
        if (Array.isArray(arr)) {
          arr.forEach((x, i) => {
            out[i] = x && x.result != null ? x.result : null;
          });
        }
      }
    } catch {}
  }

  // 2) Upstash pipeline for missing
  if (UP_URL && UP_TOKEN && keys.length) {
    try {
      const missingIdx = out.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
      if (missingIdx.length) {
        const r = await fetch(`${UP_URL}/pipeline`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${UP_TOKEN}`,
            "content-type": "application/json",
          },
          cache: "no-store",
          body: JSON.stringify({
            commands: missingIdx.map((i) => ["GET", keys[i]]),
          }),
        });
        if (r.ok) {
          const arr = await r.json().catch(() => null);
          if (Array.isArray(arr)) {
            arr.forEach((x, j) => {
              const idx = missingIdx[j];
              out[idx] = x && x.result != null ? x.result : null;
            });
          }
        }
      }
    } catch {}
  }

  // 3) Ako pipeline nije dostupan, fallback na pojedinačna čitanja
  for (let i = 0; i < keys.length; i++) {
    if (out[i] == null) out[i] = await kvGet(keys[i]); // pojedinačno
  }

  return out;
}
