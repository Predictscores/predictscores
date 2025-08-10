// pages/api/value-bets.js
// Jednostavan, štedljiv endpoint sa keširanjem i "pauza" prekidačem.
// Koristi API-FOOTBALL (v3) samo 1 poziv po danu, pravi max 10 pickova.
// Env promenljive:
//  API_FOOTBALL_KEY
//  FOOTBALL_PAUSE=0|1
//  FOOTBALL_TTL_SECONDS=900
//  MAX_APIFOOTBALL_CALLS=200
export const config = { api: { bodyParser: false } };

const API_BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || "";

const FOOTBALL_PAUSE = process.env.FOOTBALL_PAUSE === "1";
const FOOTBALL_TTL_SECONDS = Number(process.env.FOOTBALL_TTL_SECONDS || "900");

let _cache = {
  dayKey: null,
  payload: null,
  ts: 0,
};

let _budget = {
  dayKey: null,
  used: 0,
  max: Number(process.env.MAX_APIFOOTBALL_CALLS || "200"),
};

function todayUTC() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toISOZ(s) {
  if (!s) return null;
  const x = String(s);
  if (x.endsWith("Z")) return x;
  if (x.includes("T")) return x + "Z";
  return x.replace(" ", "T") + "Z";
}

function basicModelPick(fix) {
  // Jeftin model: home bias + "U19" slabije poverenje
  let pHome = 0.56;
  let pDraw = 0.22;
  let pAway = 0.22;

  const ln = String(fix?.league?.name || "").toLowerCase();
  if (ln.includes("u19") || ln.includes("youth")) {
    pHome -= 0.06;
    pDraw += 0.03;
    pAway += 0.03;
  }

  let pick = "1";
  let prob = pHome;
  if (pDraw > prob) {
    pick = "X";
    prob = pDraw;
  }
  if (pAway > prob) {
    pick = "2";
    prob = pAway;
  }
  const bucket = prob >= 0.9 ? "TOP" : prob >= 0.75 ? "High" : prob >= 0.5 ? "Moderate" : "Low";
  const score = Math.round(prob * 100 * 1.25); // rangiranje

  return { pick, prob, bucket, score };
}

async function afetch(path) {
  const dayKey = todayUTC();
  if (_budget.dayKey !== dayKey) _budget = { dayKey, used: 0, max: _budget.max };
  if (_budget.used >= _budget.max) {
    return { ok: false, status: 429, json: null, reason: "budget-exhausted" };
  }
  const headers = { "x-apisports-key": API_KEY };
  const res = await fetch(`${API_BASE}${path}`, { headers });
  _budget.used += 1;
  try {
    const json = await res.json();
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: res.status, json: null };
  }
}

export default async function handler(req, res) {
  try {
    if (FOOTBALL_PAUSE) {
      return res.status(200).json({
        value_bets: [],
        generated_at: new Date().toISOString(),
        note: "paused",
      });
    }

    const dayKey = todayUTC();
    const now = Date.now();

    // TTL keš
    if (_cache.dayKey === dayKey && _cache.payload && now - _cache.ts < FOOTBALL_TTL_SECONDS * 1000) {
      res.setHeader("Cache-Control", `s-maxage=${FOOTBALL_TTL_SECONDS}, stale-while-revalidate=${FOOTBALL_TTL_SECONDS}`);
      return res.status(200).json(_cache.payload);
    }

    if (!API_KEY) {
      const empty = { value_bets: [], generated_at: new Date().toISOString(), note: "no api key" };
      _cache = { dayKey, payload: empty, ts: now };
      res.setHeader("Cache-Control", `s-maxage=${FOOTBALL_TTL_SECONDS}`);
      return res.status(200).json(empty);
    }

    // 1 poziv: današnji mečevi
    const resp = await afetch(`/fixtures?date=${encodeURIComponent(dayKey)}`);
    const arr = Array.isArray(resp?.json?.response) ? resp.json.response : [];

    const mapped = arr.map((f) => {
      const model = basicModelPick(f);
      return {
        fixture_id: f?.fixture?.id ?? null,
        market: "1X2",
        selection: model.pick,
        type: "FALLBACK",
        model_prob: model.prob,
        market_odds: null,
        edge: null,

        datetime_local: {
          starting_at: {
            date_time: toISOZ(f?.fixture?.date) || null,
          },
        },

        teams: {
          home: { id: f?.teams?.home?.id ?? null, name: f?.teams?.home?.name ?? null },
          away: { id: f?.teams?.away?.id ?? null, name: f?.teams?.away?.name ?? null },
        },

        league: {
          id: f?.league?.id ?? null,
          name: f?.league?.name ?? null,
          country: f?.league?.country ?? null,
          season: f?.league?.season ?? null,
        },

        confidence_pct: Math.round(model.prob * 100),
        confidence_bucket: model.bucket,
        _score: model.score,
      };
    });

    // sortiraj po našem _score
    mapped.sort((a, b) => (b?._score ?? 0) - (a?._score ?? 0));

    const top = mapped.slice(0, 10);
    const payload = { value_bets: top, generated_at: new Date().toISOString() };

    _cache = { dayKey, payload, ts: now };
    res.setHeader("Cache-Control", `s-maxage=${FOOTBALL_TTL_SECONDS}, stale-while-revalidate=${FOOTBALL_TTL_SECONDS}`);
    return res.status(200).json(payload);
  } catch (e) {
    const fallback = { value_bets: [], generated_at: new Date().toISOString(), error: String(e?.message || e) };
    return res.status(200).json(fallback);
  }
}
