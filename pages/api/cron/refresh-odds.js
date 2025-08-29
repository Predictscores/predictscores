// pages/api/cron/refresh-odds.js
// Cilj: upisati REALNE (named) 1X2 kvote po bukmejkerima u KV/Upstash.
// Pokušaj 1: API-Football v3 /odds?fixture=<id>
// Fallback: agregatni sažetak (ako baš nema named kvota).
//
// Ključevi koje pišemo (top-level JSON string):
//   odds:<YMD>:<fixtureId>
//   odds:fixture:<YMD>:<fixtureId>
//   (radi kompatibilnosti i sa starijim reader-ima)
//
// Posle ovoga /api/value-bets će AUTOMATSKI preferirati named/trusted kvote,
// pa će confidence i cene izgledati normalno (nema plafona 68/85 za sve).

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
const AF_BASE =
  (process.env.API_FOOTBALL_BASE_URL || "").trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  (process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "").trim();

// KV / Upstash
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Budžeti / limiti
const PER_FIXTURE_TIMEOUT_MS = clampInt(process.env.ODDS_PER_FIXTURE_TIMEOUT_MS, 4000, 1000, 15000);
const ODDS_PER_FIXTURE_CAP   = clampInt(process.env.ODDS_PER_FIXTURE_CAP, 1, 1, 5); // koliko puta pokušavamo odds endpoint za jedan fixture
const ODDS_BATCH_MAX_PAGES   = clampInt(process.env.ODDS_BATCH_MAX_PAGES, 25, 1, 200);

// Slot granice (Europe/Belgrade): late 00–09:59, am 10–14:59, pm 15–23:59
export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    // 1) fixtures za dan
    const fixtures = await fetchFixturesAF(ymd, TZ);
    const windowFixtures = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));
    const pages = Math.min(Math.ceil(windowFixtures.length / 50), ODDS_BATCH_MAX_PAGES);

    let namedWritten = 0;
    let aggWritten = 0;
    let processed = 0;

    for (let p = 0; p < pages; p++) {
      const chunk = windowFixtures.slice(p * 50, (p + 1) * 50);

      for (const fx of chunk) {
        const fid = getFID(fx);
        if (!fid) continue;

        // 2) probaj da dobiješ NAMED kvote od API-Football
        let named = null;
        for (let attempt = 0; attempt < ODDS_PER_FIXTURE_CAP; attempt++) {
          named = await fetchAFOddsForFixture(fid, PER_FIXTURE_TIMEOUT_MS);
          if (named && Array.isArray(named.bookmakers) && named.bookmakers.length) break;
        }

        if (named && Array.isArray(named.bookmakers) && named.bookmakers.length) {
          // 2a) upiši RAW API-Football odds objekt (bookmakers/bets/values)
          await kvSetOdds(ymd, fid, named);
          namedWritten++;
        } else {
          // 3) fallback — agregat 1X2 ako nema named
          const agg = makeAggregateFromFixture(fx); // sažetak (bez bukija)
          await kvSetOdds(ymd, fid, agg);
          aggWritten++;
        }
        processed++;
      }
    }

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      fixtures: windowFixtures.length,
      batch_pages: pages,
      batch_items: processed,
      odds_cached: namedWritten + aggWritten,
      named_written: namedWritten,
      aggregate_written: aggWritten,
      source: namedWritten ? "API_FOOTBALL_ODDS(named)" : "aggregate-fallback",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ================= API-Football helpers ================= */

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

// Pokušaj da dobiješ odds po fixture-u (named)
async function fetchAFOddsForFixture(fid, timeoutMs) {
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 4000) : null;

    const url = `${AF_BASE.replace(/\/+$/, "")}/odds?fixture=${encodeURIComponent(fid)}`;
    const r = await fetch(url, {
      headers: { "x-apisports-key": AF_KEY, accept: "application/json" },
      signal: ctrl ? ctrl.signal : undefined,
      cache: "no-store",
    }).catch(() => null);

    if (timer) clearTimeout(timer);
    if (!r || !r.ok) return null;

    const j = await r.json().catch(() => null);
    // očekivano: { response: [ { bookmakers: [ { name, bets:[{ name, values:[{ value, odd }] }] } ] } ] }
    const first = Array.isArray(j?.response) && j.response.length ? j.response[0] : null;
    if (!first || !Array.isArray(first.bookmakers) || !first.bookmakers.length) return null;
    return first;
  } catch {
    return null;
  }
}

/* ================= Storage ================= */

async function kvSetOdds(ymd, fixtureId, obj) {
  const payload = JSON.stringify(obj);
  const keys = [
    `odds:${ymd}:${fixtureId}`,
    `odds:fixture:${ymd}:${fixtureId}`, // kompatibilnost
  ];

  // KV primary
  if (KV_URL && KV_TOKEN) {
    for (const key of keys) {
      try {
        const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${KV_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: payload }),
        });
        if (!r.ok) throw new Error("KV set failed");
      } catch {
        // probaj sledeći key / fallback
      }
    }
  }

  // Upstash fallback
  if (UP_URL && UP_TOKEN) {
    for (const key of keys) {
      try {
        const r = await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${UP_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ value: payload }),
        });
        if (!r.ok) throw new Error("Upstash set failed");
      } catch {
        // ignore
      }
    }
  }
}

/* ================= Normalization & misc ================= */

function makeAggregateFromFixture(fx) {
  // Ovo ostavlja minimalan sažetak, koji /api/value-bets zna da pročita kao MW_SUMMARY
  return {
    match_winner: {
      home: null,
      draw: null,
      away: null,
    },
    // možeš dodatno popuniti iz drugih izvora ako želiš
  };
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

function getFID(fx) { return fx?.fixture?.id ?? fx?.id ?? null; }
function getKOISO(fx) {
  const raw = fx?.fixture?.date || fx?.datetime_local?.starting_at?.date_time || fx?.datetime_local?.date_time || fx?.kickoff || null;
  if (!raw) return null;
  return String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T");
}

function inSlotWindow(iso, tz, slot) {
  if (!iso) return false;
  const d = new Date(iso);
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(d));
  if (slot === "late") return h < 10;
  if (slot === "am") return h >= 10 && h < 15;
  return h >= 15 && h <= 23;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (s.split(",")[0] || s).trim();
}
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }
function clampInt(v, defVal, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defVal;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
