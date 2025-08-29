// pages/api/cron/refresh-odds.js
// Upisuje kvote po meču u KV/Upstash za današnji dan i slot.
// 1) Pokuša API-Football /v3/odds?fixture=<id> (named bookmakers -> bets -> values)
// 2) Ako nema named, a postoji ODDS_API_KEY i budžet: pokuša "The Odds API" (ograničeno na poznate lige)
// 3) Ako ni to: upiše aggregate MW sažetak (fallback), čisto da feed ne ostane prazan.
//
// Ključevi koje pišemo:
//   odds:<YMD>:<fixtureId>
//   odds:fixture:<YMD>:<fixtureId>
//
// Budžet: ODDS_CALL_BUDGET_DAILY (npr. 12-16 najbolje), persistrano u KV pod "odds:budget:<YMD>"

export const config = { api: { bodyParser: false } };

/* ================= ENV ================= */
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
const AF_BASE =
  (process.env.API_FOOTBALL_BASE_URL || "").trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  (process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "").trim();

// Odds API (The Odds API – v4) — opcioni drugi pokušaj
const ODDS_API_KEY = (process.env.ODDS_API_KEY || "").trim();
// dnevni limit poziva prema ODDS_API (koliko max poziva želimo danas)
const ODDS_CALL_BUDGET_DAILY = clampInt(process.env.ODDS_CALL_BUDGET_DAILY, 12, 1, 100);

// KV / Upstash
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Operativni limiti
const PER_FIXTURE_TIMEOUT_MS = clampInt(process.env.ODDS_PER_FIXTURE_TIMEOUT_MS, 4000, 1000, 15000);
const ODDS_PER_FIXTURE_CAP   = clampInt(process.env.ODDS_PER_FIXTURE_CAP, 1, 1, 5);
const ODDS_BATCH_MAX_PAGES   = clampInt(process.env.ODDS_BATCH_MAX_PAGES, 25, 1, 200);

/* ================ HANDLER ================ */
export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    // 1) fixtures (današnji)
    const fixtures = await fetchFixturesAF(ymd, TZ);
    const inWindow = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));

    // Strani u stranice po 50
    const pages = Math.min(Math.ceil(inWindow.length / 50), ODDS_BATCH_MAX_PAGES);

    // Dnevni budžet za ODDS_API (drugi pokušaj), čuvamo i trošimo iz KV
    let oddsBudget = await getDailyBudget(ymd);
    if (oddsBudget == null || !Number.isFinite(oddsBudget)) {
      oddsBudget = ODDS_CALL_BUDGET_DAILY;
      await setDailyBudget(ymd, oddsBudget);
    }

    let processed = 0;
    let namedWritten = 0;
    let aggregateWritten = 0;
    let oddsAPIWritten = 0;
    let cachedSkip = 0;

    for (let p = 0; p < pages; p++) {
      const chunk = inWindow.slice(p * 50, (p + 1) * 50);

      for (const fx of chunk) {
        const fid = getFID(fx);
        if (!fid) continue;

        // Ako već imamo NAMED kvote za ovaj fixture danas — preskoči (čuva budžet)
        const existing = await kvGetAny([
          `odds:${ymd}:${fid}`,
          `odds:fixture:${ymd}:${fid}`,
        ]);
        if (hasNamedBookmakers(existing)) {
          cachedSkip++;
          processed++;
          continue;
        }

        // 2) Pokušaj API-Football named odds
        let wrote = false;
        const named = await fetchAFOddsForFixture(fid, PER_FIXTURE_TIMEOUT_MS, ODDS_PER_FIXTURE_CAP);
        if (hasNamedBookmakers(named)) {
          await kvSetOdds(ymd, fid, named);
          namedWritten++;
          wrote = true;
        } else {
          // 3) Ako nema named iz AF, a imamo ODDS_API_KEY i budžet: pokuša The Odds API (ograničeno)
          if (ODDS_API_KEY && oddsBudget > 0) {
            const tryOdds = await fetchOddsAPIForFixture(fx, ODDS_API_KEY, PER_FIXTURE_TIMEOUT_MS);
            if (hasNamedBookmakers(tryOdds)) {
              await kvSetOdds(ymd, fid, tryOdds);
              oddsAPIWritten++;
              oddsBudget--;
              await setDailyBudget(ymd, oddsBudget);
              wrote = true;
            }
          }
        }

        // 4) Ako ništa named nije prošlo, upiši aggregate fallback (da feed ne bude prazan)
        if (!wrote) {
          const agg = makeAggregateMWFromExisting(existing) || makeAggregateSkeleton();
          await kvSetOdds(ymd, fid, agg);
          aggregateWritten++;
        }

        processed++;
      }
    }

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      fixtures: inWindow.length,
      batch_pages: pages,
      batch_items: processed,
      odds_cached: namedWritten + aggregateWritten + oddsAPIWritten,
      named_written: namedWritten,
      odds_api_written: oddsAPIWritten,
      aggregate_written: aggregateWritten,
      cached_named_kept: cachedSkip,
      odds_api_budget_left: oddsBudget,
      source: namedWritten || oddsAPIWritten ? "named" : "aggregate-fallback",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ========== API-FOOTBALL ========== */

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

async function fetchAFOddsForFixture(fid, timeoutMs, retries = 1) {
  let last = null;
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const tm = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 4000) : null;

      const url = `${AF_BASE.replace(/\/+$/, "")}/odds?fixture=${encodeURIComponent(fid)}`;
      const r = await fetch(url, {
        headers: { "x-apisports-key": AF_KEY, accept: "application/json" },
        signal: ctrl ? ctrl.signal : undefined,
        cache: "no-store",
      }).catch(() => null);

      if (tm) clearTimeout(tm);
      if (!r || !r.ok) { last = null; continue; }

      const j = await r.json().catch(() => null);
      const first = Array.isArray(j?.response) && j.response.length ? j.response[0] : null;
      if (first && Array.isArray(first.bookmakers) && first.bookmakers.length) {
        return first;
      }
      last = first || null;
    } catch {
      last = null;
    }
  }
  return last;
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

/* ========== The Odds API (ODDS_API_KEY) – ograničen pokušaj ========== */
/**
 * Pokuša da dobije H2H kvote za fixture:
 * - ograničeno na prepoznate liga-ključevе (da ne proždere limit),
 * - filtrira po imenima timova (case-insensitive contains) i vremenu kickoff-a (~ isti dan).
 * Vraća objekat u API-Football formatu: { bookmakers: [ { name, bets:[{ name:"Match Winner", values:[{ value, odd }, ...] }] } ] }
 */
async function fetchOddsAPIForFixture(fx, apiKey, timeoutMs) {
  try {
    const leagueKey = guessTheOddsAPISportKey(fx?.league?.name || "", fx?.league?.country || "");
    if (!leagueKey) return null; // ne pokušavaj nasumično — čuva budžet

    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const tm = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 4000) : null;

    // v4 format: https://api.the-odds-api.com/v4/sports/{sport_key}/odds
    const params = new URLSearchParams({
      apiKey,
      regions: "eu",
      markets: "h2h",
      dateFormat: "iso",
      oddsFormat: "decimal",
    });

    // Ako imaš listu trusted/bookies, probaj da je proslediš (neki bukiji moraju tačno po njihovim ključevima)
    const trusted = (process.env.TRUSTED_BOOKMAKERS || process.env.TRUSTED_BOOKIES || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .join(",");
    if (trusted) params.set("bookmakers", trusted);

    const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(leagueKey)}/odds?${params.toString()}`;

    const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: "no-store" }).catch(() => null);
    if (tm) clearTimeout(tm);
    if (!r || !r.ok) return null;

    const arr = await r.json().catch(() => null);
    if (!Array.isArray(arr) || !arr.length) return null;

    const homeName = String(fx?.teams?.home?.name || "").toLowerCase();
    const awayName = String(fx?.teams?.away?.name || "").toLowerCase();
    const koDay = (getKOISO(fx) || "").slice(0, 10);

    // nađi event koji odgovara timovima i istom danu
    const match = arr.find(ev => {
      const t1 = String(ev?.home_team || ev?.teams?.home || "").toLowerCase();
      const t2 = String(ev?.away_team || ev?.teams?.away || "").toLowerCase();
      const okTeams = (t1.includes(homeName) || homeName.includes(t1)) && (t2.includes(awayName) || awayName.includes(t2));
      const day = String(ev?.commence_time || "").slice(0, 10);
      return okTeams && day === koDay;
    });
    if (!match || !Array.isArray(match.bookmakers)) return null;

    // mapiraj u API-Football-like strukturu
    const bms = [];
    for (const bk of match.bookmakers) {
      const outcomes = (bk?.markets || bk?.markets_h2h || bk?.markets?.h2h || [])
        .find(m => (m.key || m.market || "").toString().toLowerCase().includes("h2h") || (m.outcomes && m.outcomes.length));
      const vals = Array.isArray(outcomes?.outcomes) ? outcomes.outcomes : [];
      const values = [];
      for (const v of vals) {
        const name = String(v?.name || v?.outcome || "");
        const odd  = Number(v?.price || v?.odd || v?.decimal || v?.odds);
        if (!Number.isFinite(odd)) continue;
        // normalizuj u API-Football "values"
        const selection =
          /draw/i.test(name) ? "Draw" :
          /home|1$/i.test(name) ? "Home" :
          /away|2$/i.test(name) ? "Away" : name;
        values.push({ value: selection, odd: String(odd) });
      }
      if (values.length) {
        bms.push({ name: bk?.title || bk?.key || bk?.name || "unknown", bets: [{ name: "Match Winner", values }] });
      }
    }
    if (!bms.length) return null;

    return { bookmakers: bms };
  } catch {
    return null;
  }
}

// Primitivni map poznatih ključева za The Odds API (proširi po potrebi, čuva budžet)
function guessTheOddsAPISportKey(leagueName, country) {
  const L = String(leagueName || "").toLowerCase();
  const C = String(country || "").toLowerCase();

  if (C.includes("england") && /premier/i.test(L) && !/2|two|pl2/i.test(L)) return "soccer_epl";
  if (C.includes("england") && /championship/i.test(L)) return "soccer_efl_championship";
  if (C.includes("spain")   && /liga/i.test(L)) return "soccer_la_liga";
  if (C.includes("italy")   && /serie a/i.test(L)) return "soccer_italy_serie_a";
  if (C.includes("germany") && /bundes/i.test(L)) return "soccer_germany_bundesliga";
  if (C.includes("france")  && /ligue 1|ligue one/i.test(L)) return "soccer_france_ligue_one";
  if (C.includes("nether")  && /erediv/i.test(L)) return "soccer_netherlands_eredivisie";
  if (C.includes("portu")   && /primeira|liga portugal/i.test(L)) return "soccer_portugal_primeira_liga";
  if (C.includes("turkey")  && /super lig/i.test(L)) return "soccer_turkey_super_league";
  if (C.includes("belg")    && /pro league|first div/i.test(L)) return "soccer_belgium_first_div";
  if (C.includes("greece")  && /super league/i.test(L)) return "soccer_greece_super_league";
  if (/champions league/i.test(L)) return "soccer_uefa_champs_league";
  if (/europa league/i.test(L))    return "soccer_uefa_europa_league";
  // Ako nije poznato — vrati null (ne pokušavaj nasumično, čuva budžet)
  return null;
}

/* ========== STORAGE ========== */

async function kvSetOdds(ymd, fixtureId, obj) {
  const payload = JSON.stringify(obj);
  const keys = [
    `odds:${ymd}:${fixtureId}`,
    `odds:fixture:${ymd}:${fixtureId}`,
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
      } catch {}
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
      } catch {}
    }
  }
}

async function kvGetAny(keys) {
  for (const k of keys) {
    const v = await kvGet(k);
    if (v != null) return parseMaybeJSON(v);
  }
  return null;
}

async function kvGet(key) {
  // KV primary
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
  // Upstash fallback
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

// budžet per dan (persistran u KV)
async function getDailyBudget(ymd) {
  const v = await kvGet(`odds:budget:${ymd}`);
  const n = Number(parseMaybeJSON(v));
  return Number.isFinite(n) ? n : null;
}
async function setDailyBudget(ymd, n) {
  const payload = JSON.stringify(n);
  const key = `odds:budget:${ymd}`;
  if (KV_URL && KV_TOKEN) {
    try {
      await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: payload }),
      });
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: payload }),
      });
    } catch {}
  }
}

/* ========== UTILS ========== */

function hasNamedBookmakers(v) {
  try {
    const obj = parseMaybeJSON(v);
    const bms = obj && Array.isArray(obj.bookmakers) ? obj.bookmakers : null;
    return !!(bms && bms.length);
  } catch { return false; }
}

function makeAggregateSkeleton() {
  return { match_winner: { home: null, draw: null, away: null } };
}
function makeAggregateMWFromExisting(v) {
  try {
    const obj = parseMaybeJSON(v);
    if (!obj) return null;
    if (obj.match_winner) return obj; // već agregat
    // pokušaj da sintetizuješ MW iz api-sports ako je moguće (rz. nije obavezno)
    return null;
  } catch { return null; }
}

function parseMaybeJSON(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch { return v; }
  }
  if (typeof v === "object") {
    if (v.value != null) return parseMaybeJSON(v.value);
    if (v.data  != null) return parseMaybeJSON(v.data);
    if (v.payload != null) return parseMaybeJSON(v.payload);
    return v;
  }
  return null;
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
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }
function clampInt(v, defVal, min, max) { const n = Number(v); if (!Number.isFinite(n)) return defVal; return Math.max(min, Math.min(max, Math.floor(n))); }
