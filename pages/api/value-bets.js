// FILE: pages/api/value-bets.js
// Minimal, stable pipeline (API-FOOTBALL fixtures only) so you ALWAYS get picks.
// Next step (after you confirm this works): add odds-based edges via API-FOOTBALL /odds.

export const config = { api: { bodyParser: false } };

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY || "";
const TZ_DISPLAY = process.env.TZ_DISPLAY || "Europe/Belgrade";

// how many picks to return
const DESIRED_PICKS = 10;

// lower fallback threshold so we always have suggestions (you asked to allow weaker ones)
const FALLBACK_MIN_PROB = Number(process.env.FALLBACK_MIN_PROB || "0.36");

// in-memory cache (reduce API calls)
let _cache = { day: null, data: null, fetchedAt: 0 };

function todayYMD(tz = "UTC") {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [{ value: y }, , { value: m }, , { value: dd }] = fmt.formatToParts(d);
  return `${y}-${m}-${dd}`;
}

function toNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function belgradeFromIso(isoUtc) {
  try {
    const d = new Date(isoUtc);
    const fmtD = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ_DISPLAY,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const fmtT = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ_DISPLAY,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const [{ value: y }, , { value: m }, , { value: da }] = fmtD.formatToParts(d);
    return `${y}-${m}-${da} ${fmtT.format(d)}`;
  } catch {
    return isoUtc;
  }
}

// very simple model: home baseline + tiny draw; safe, deterministic
function simple1x2Model() {
  // baseline that produces a pick without being absurd
  const pHome = 0.46;
  const pDraw = 0.27;
  const pAway = 0.27;
  // confidence from gap between top2
  const arr = [
    { k: "home", v: pHome },
    { k: "draw", v: pDraw },
    { k: "away", v: pAway },
  ].sort((a, b) => b.v - a.v);
  const gap = arr[0].v - arr[1].v;
  const confidencePct = clamp(Math.round((gap / 0.5) * 100), 0, 100);
  return { probs: { home: pHome, draw: pDraw, away: pAway }, top: arr[0].k, confidencePct };
}

function confidenceBucket(p) {
  if (p >= 0.90) return "TOP";
  if (p >= 0.75) return "High";
  if (p >= 0.50) return "Moderate";
  return "Low";
}

// score to rank fallback picks (uses prob & time-to-KO)
function rankScore(prob, kickoffIso) {
  let tHrs = 24;
  try {
    tHrs = (new Date(kickoffIso).getTime() - Date.now()) / 3600000;
  } catch {}
  const tFactor = clamp(1 - Math.abs(tHrs - 6) / 24, 0, 1); // mild preference for matches within ~6–12h
  return Math.round((prob * 0.8 + tFactor * 0.2) * 100); // 0–100
}

async function fetchFixturesAF(dateYMD) {
  // cache per day to minimize calls
  if (_cache.day === dateYMD && _cache.data && Date.now() - _cache.fetchedAt < 30 * 60 * 1000) {
    return _cache.data;
  }
  if (!API_FOOTBALL_KEY) {
    throw new Error("Missing API_FOOTBALL_KEY env");
  }

  const url = `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(
    dateYMD
  )}`;
  const res = await fetch(url, {
    headers: {
      "x-apisports-key": API_FOOTBALL_KEY,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API-FOOTBALL fixtures HTTP ${res.status} – ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  _cache = { day: dateYMD, data: json, fetchedAt: Date.now() };
  return json;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const dateParam = url.searchParams.get("date"); // allow ?date=YYYY-MM-DD
    const dateYMD = dateParam || todayYMD(TZ_DISPLAY);

    const fixturesJson = await fetchFixturesAF(dateYMD);
    const list = Array.isArray(fixturesJson?.response) ? fixturesJson.response : [];

    // map fixtures → fallback picks (no odds yet)
    const rawPicks = list.map((f) => {
      const fx = f?.fixture || {};
      const lg = f?.league || {};
      const tm = f?.teams || {};
      const iso = fx?.date || null; // ISO string
      const belgrade = iso ? belgradeFromIso(iso) : "";

      const model = simple1x2Model();
      const sel = model.top; // "home" | "draw" | "away"
      const prob = model.probs[sel];

      // to 1/X/2 label
      const label = sel === "home" ? "1" : sel === "draw" ? "X" : "2";

      const pick = {
        fixture_id: fx?.id ?? null,
        market: "1X2",
        selection: label,
        type: "FALLBACK", // for now (no odds yet)
        model_prob: prob,
        market_odds: null,
        edge: null,
        datetime_local: { starting_at: { date_time: belgrade } },
        teams: {
          home: { id: tm?.home?.id ?? null, name: tm?.home?.name ?? "Home" },
          away: { id: tm?.away?.id ?? null, name: tm?.away?.name ?? "Away" },
        },
        league: {
          id: lg?.id ?? null,
          name: lg?.name ?? "League",
          country: lg?.country ?? null,
        },
        confidence_pct: Math.round(prob * 100),
        confidence_bucket: confidenceBucket(prob),
        _score: rankScore(prob, iso),
      };
      return pick;
    });

    // filter by min prob (low threshold so we always have items)
    const eligible = rawPicks.filter((p) => toNumber(p.model_prob, 0) >= FALLBACK_MIN_PROB);

    // sort by score and keep top N
    eligible.sort((a, b) => toNumber(b._score, 0) - toNumber(a._score, 0));
    const out = eligible.slice(0, DESIRED_PICKS);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=900");
    return res.status(200).json({ value_bets: out, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error("value-bets error:", e?.message || e);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=300");
    return res.status(200).json({ value_bets: [], note: "error, returned empty" });
  }
}
