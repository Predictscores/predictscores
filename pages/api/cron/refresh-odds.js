// pages/api/cron/refresh-odds.js
// Upisuje KV odds samo ako nađemo NAMED bukmejkere (API-Football ili The Odds API).
// NEMA agregatnog fallback-a. Ako nema named, ne pišemo ništa za taj fixture.
//
// Ključevi (JSON string):
//   odds:<YMD>:<fixtureId>
//   odds:fixture:<YMD>:<fixtureId>
//
// Budžet za The Odds API: ODDS_CALL_BUDGET_DAILY (npr. 15)

export const config = { api: { bodyParser: false } };

/* ================= ENV ================= */
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// API-Football
const AF_BASE =
  (process.env.API_FOOTBALL_BASE_URL || "").trim() ||
  "https://v3.football.api-sports.io";
const AF_KEY =
  (process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL || "").trim();

// The Odds API (v4) — opcioni drugi pokušaj
const ODDS_API_KEY = (process.env.ODDS_API_KEY || "").trim();
const ODDS_CALL_BUDGET_DAILY = clampInt(process.env.ODDS_CALL_BUDGET_DAILY, 15, 1, 100);

// KV / Upstash
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Operativni limiti
const PER_FIXTURE_TIMEOUT_MS = clampInt(process.env.ODDS_PER_FIXTURE_TIMEOUT_MS, 4000, 1000, 15000);
const ODDS_PER_FIXTURE_CAP   = clampInt(process.env.ODDS_PER_FIXTURE_CAP, 1, 1, 5);
const ODDS_BATCH_MAX_PAGES   = clampInt(process.env.ODDS_BATCH_MAX_PAGES, 25, 1, 200);

export default async function handler(req, res) {
  try {
    const slot = normalizeSlot(String(req.query?.slot || "pm"));
    const ymd  = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));

    const fixtures = await fetchFixturesAF(ymd, TZ);
    const inWindow = fixtures.filter((fx) => inSlotWindow(getKOISO(fx), TZ, slot));
    const pages = Math.min(Math.ceil(inWindow.length / 50), ODDS_BATCH_MAX_PAGES);

    // dnevni budžet za The Odds API
    let budget = await getDailyBudget(ymd);
    if (budget == null) { budget = ODDS_CALL_BUDGET_DAILY; await setDailyBudget(ymd, budget); }

    let processed = 0, namedWritten = 0, oddsAPIWritten = 0, cachedNamedKeep = 0, skippedNoNamed = 0;

    for (let p = 0; p < pages; p++) {
      const chunk = inWindow.slice(p * 50, (p + 1) * 50);

      for (const fx of chunk) {
        const fid = getFID(fx);
        if (!fid) continue;

        // ako već postoji named u storage-u za danas, preskoči
        const existing = await kvGetAny([`odds:${ymd}:${fid}`, `odds:fixture:${ymd}:${fid}`]);
        if (hasNamedBookmakers(existing)) { cachedNamedKeep++; processed++; continue; }

        // 1) API-Football named
        const named = await fetchAFOddsForFixture(fid, PER_FIXTURE_TIMEOUT_MS, ODDS_PER_FIXTURE_CAP);
        if (hasNamedBookmakers(named)) {
          await kvSetOdds(ymd, fid, named);
          namedWritten++; processed++; continue;
        }

        // 2) The Odds API (ako imamo ključ i budžet i ako liga prepoznata)
        if (ODDS_API_KEY && budget > 0) {
          const tryOdds = await fetchOddsAPIForFixture(fx, ODDS_API_KEY, PER_FIXTURE_TIMEOUT_MS);
          if (hasNamedBookmakers(tryOdds)) {
            await kvSetOdds(ymd, fid, tryOdds);
            oddsAPIWritten++; budget--; await setDailyBudget(ymd, budget);
            processed++; continue;
          }
        }

        // 3) nema named → ne pišemo ništa (bez agregata)
        skippedNoNamed++; processed++;
      }
    }

    return res.status(200).json({
      ok: true,
      ymd, slot,
      fixtures: inWindow.length,
      batch_pages: pages,
      batch_items: processed,
      named_written: namedWritten,
      odds_api_written: oddsAPIWritten,
      cached_named_kept: cachedNamedKeep,
      skipped_no_named: skippedNoNamed,
      odds_api_budget_left: budget,
      source: (namedWritten || oddsAPIWritten) ? "named" : "none-written(no-named)",
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

/* ===== API-Football ===== */
async function fetchFixturesAF(ymd, tz) {
  try {
    const url = `${AF_BASE.replace(/\/+$/, "")}/fixtures?date=${encodeURIComponent(ymd)}&timezone=${encodeURIComponent(tz)}`;
    const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY, accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const arr = Array.isArray(j?.response) ? j.response : Array.isArray(j) ? j : [];
    return arr.map(normalizeAF);
  } catch { return []; }
}

async function fetchAFOddsForFixture(fid, timeoutMs, retries = 1) {
  let last = null;
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const tm = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 4000) : null;
      const url = `${AF_BASE.replace(/\/+$/, "")}/odds?fixture=${encodeURIComponent(fid)}`;
      const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY, accept: "application/json" }, signal: ctrl?.signal, cache: "no-store" }).catch(() => null);
      if (tm) clearTimeout(tm);
      if (!r || !r.ok) { last = null; continue; }
      const j = await r.json().catch(() => null);
      const first = Array.isArray(j?.response) && j.response.length ? j.response[0] : null;
      if (first && Array.isArray(first.bookmakers) && first.bookmakers.length) return first;
      last = first || null;
    } catch { last = null; }
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

/* ===== The Odds API (v4) — ograničen pokušaj ===== */
async function fetchOddsAPIForFixture(fx, apiKey, timeoutMs) {
  try {
    const leagueKey = guessTheOddsAPISportKey(fx?.league?.name || "", fx?.league?.country || "");
    if (!leagueKey) return null;

    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const tm = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 4000) : null;

    const params = new URLSearchParams({
      apiKey, regions: "eu", markets: "h2h", dateFormat: "iso", oddsFormat: "decimal",
    });

    const trusted = (process.env.TRUSTED_BOOKMAKERS || process.env.TRUSTED_BOOKIES || "")
      .split(",").map(s => s.trim()).filter(Boolean).join(",");
    if (trusted) params.set("bookmakers", trusted);

    const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(leagueKey)}/odds?${params.toString()}`;
    const r = await fetch(url, { signal: ctrl?.signal, cache: "no-store" }).catch(() => null);
    if (tm) clearTimeout(tm);
    if (!r || !r.ok) return null;

    const arr = await r.json().catch(() => null);
    if (!Array.isArray(arr) || !arr.length) return null;

    const homeName = String(fx?.teams?.home?.name || "").toLowerCase();
    const awayName = String(fx?.teams?.away?.name || "").toLowerCase();
    const koDay = (getKOISO(fx) || "").slice(0, 10);

    const match = arr.find(ev => {
      const t1 = String(ev?.home_team || ev?.teams?.home || "").toLowerCase();
      const t2 = String(ev?.away_team || ev?.teams?.away || "").toLowerCase();
      const okTeams = (t1.includes(homeName) || homeName.includes(t1)) && (t2.includes(awayName) || awayName.includes(t2));
      const day = String(ev?.commence_time || "").slice(0, 10);
      return okTeams && day === koDay;
    });
    if (!match || !Array.isArray(match.bookmakers)) return null;

    const bms = [];
    for (const bk of match.bookmakers) {
      const m = (bk?.markets || []).find(mm => (mm.key || "").toLowerCase() === "h2h" || /h2h/i.test(mm.key || ""));
      const vals = Array.isArray(m?.outcomes) ? m.outcomes : [];
      const values = [];
      for (const v of vals) {
        const name = String(v?.name || v?.outcome || "");
        const odd  = Number(v?.price || v?.odd || v?.decimal || v?.odds);
        if (!Number.isFinite(odd)) continue;
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
  } catch { return null; }
}

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
  return null;
}

/* ===== STORAGE ===== */

async function kvSetOdds(ymd, fixtureId, obj) {
  const payload = JSON.stringify(obj);
  const keys = [`odds:${ymd}:${fixtureId}`, `odds:fixture:${ymd}:${fixtureId}`];
  if (KV_URL && KV_TOKEN) {
    for (const key of keys) {
      try { await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ value: payload }),
      }); } catch {}
    }
  }
  if (UP_URL && UP_TOKEN) {
    for (const key of keys) {
      try { await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UP_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ value: payload }),
      }); } catch {}
    }
  }
}

async function kvGetAny(keys) {
  for (const k of keys) { const v = await kvGet(k); if (v != null) return parseMaybeJSON(v); }
  return null;
}
async function kvGet(key) {
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store" });
      if (r.ok) { const j = await r.json().catch(() => null); if (j && "result" in j) return j.result; }
    } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, cache: "no-store" });
      if (r.ok) { const j = await r.json().catch(() => null); if (j && "result" in j) return j.result; }
    } catch {}
  }
  return null;
}

// budžet per dan (u KV)
async function getDailyBudget(ymd) {
  const v = await kvGet(`odds:budget:${ymd}`);
  const n = Number(parseMaybeJSON(v));
  return Number.isFinite(n) ? n : null;
}
async function setDailyBudget(ymd, n) {
  const payload = JSON.stringify(n);
  const key = `odds:budget:${ymd}`;
  if (KV_URL && KV_TOKEN) {
    try { await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: payload }),
    }); } catch {}
  }
  if (UP_URL && UP_TOKEN) {
    try { await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: payload }),
    }); } catch {}
  }
}

/* ===== UTILS ===== */

function hasNamedBookmakers(v) {
  try {
    const obj = parseMaybeJSON(v);
    const bms = obj && Array.isArray(obj.bookmakers) ? obj.bookmakers : null;
    return !!(bms && bms.length);
  } catch { return false; }
}

function parseMaybeJSON(v) {
  if (v == null) return null;
  if (typeof v === "string") { const s = v.trim(); if (!s) return null; try { return JSON.parse(s); } catch { return v; } }
  if (typeof v === "object") { if (v.value != null) return parseMaybeJSON(v.value); if (v.data != null) return parseMaybeJSON(v.data); if (v.payload != null) return parseMaybeJSON(v.payload); return v; }
  return null;
}

function normalizeSlot(s) { const x = String(s || "").toLowerCase(); return ["am","pm","late"].includes(x) ? x : "pm"; }
function inSlotWindow(iso, tz, slot) {
  if (!iso) return false;
  const d = new Date(iso);
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(d));
  if (slot === "late") return h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  return h >= 15 && h <= 23;
}
function ymdInTZ(d = new Date(), tz = TZ) { const s = d.toLocaleString("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); return (s.split(",")[0] || s).trim(); }
function normalizeYMD(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ); }
function clampInt(v, defVal, min, max) { const n = Number(v); if (!Number.isFinite(n)) return defVal; return Math.max(min, Math.min(max, Math.floor(n))); }
