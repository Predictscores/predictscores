// pages/api/football.js
// Drop-in: real /v3/predictions (1X2 + OU2.5 hint) sa JSON guardovima i laganim kešom

const API_BASE = "https://v3.football.api-sports.io";
const API_KEY =
  process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
  process.env.API_FOOTBALL_KEY ||
  "";

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 min
const MAX_PRED_FIXTURES = 12;       // štedi kvotu
let _cache = { t: 0, key: "", data: null };

function nowUtc() {
  return new Date();
}
function addHours(date, h) {
  return new Date(date.getTime() + h * 3600 * 1000);
}
function toBelgradeISO(isoUtc) {
  try {
    const d = new Date(isoUtc);
    const fmt = new Intl.DateTimeFormat("sr-RS", {
      timeZone: "Europe/Belgrade",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const parts = Object.fromEntries(fmt.map(p => [p.type, p.value]));
    const dd = parts.day.padStart(2, "0");
    const mm = parts.month.padStart(2, "0");
    const yyyy = parts.year;
    const hh = parts.hour.padStart(2, "0");
    const min = parts.minute.padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  } catch {
    return isoUtc;
  }
}

async function safeJsonFetch(url, init) {
  const r = await fetch(url, init);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const raw = await r.text();
    return { ok: false, error: "non-JSON", status: r.status, raw };
  }
  const j = await r.json();
  return { ok: r.ok, status: r.status, data: j };
}

function shapePredictionItem(fx, pred) {
  const league = fx?.league || {};
  const teams = fx?.teams || {};
  const fixture = fx?.fixture || {};
  const p = pred?.predictions || {};
  const percent = p?.percent || {};
  const goals = p?.goals || {};

  const pHome = parseFloat(String(percent.home || "0").replace("%", "")) || 0;
  const pDraw = parseFloat(String(percent.draw || "0").replace("%", "")) || 0;
  const pAway = parseFloat(String(percent.away || "0").replace("%", "")) || 0;

  let selection = "DRAW";
  let model_prob = pDraw / 100;
  if (pHome >= pDraw && pHome >= pAway) {
    selection = "HOME";
    model_prob = pHome / 100;
  } else if (pAway >= pHome && pAway >= pDraw) {
    selection = "AWAY";
    model_prob = pAway / 100;
  }

  const underOver = p?.under_over || null;

  return {
    type: "PREDICTIONS",
    ok: true,
    fixture_id: fixture?.id,
    league: {
      id: league?.id,
      name: league?.name,
      country: league?.country,
    },
    teams: {
      home: teams?.home?.name,
      away: teams?.away?.name,
      home_id: teams?.home?.id,
      away_id: teams?.away?.id,
    },
    datetime_local: {
      starting_at: { date_time: toBelgradeISO(fixture?.date) },
    },
    market: "1X2",
    market_label: "1X2",
    selection, // "HOME" | "DRAW" | "AWAY"
    confidence_pct: Math.round(model_prob * 100),
    model_prob,
    extras: {
      advice: p?.advice || null,
      under_over: underOver, // OU2.5 hint (ako postoji u API odgovoru)
      goals_predicted: { home: goals?.home ?? null, away: goals?.away ?? null },
      win_or_draw: p?.win_or_draw ?? null,
      comparison: pred?.comparison || null,
    },
  };
}

export default async function handler(req, res) {
  try {
    if (!API_KEY) {
      res.setHeader("Content-Type", "application/json");
      return res
        .status(500)
        .json({ ok: false, error: "Missing API key (NEXT_PUBLIC_API_FOOTBALL_KEY)", football: [] });
    }

    const hours = Math.max(1, Math.min(24, parseInt(req.query.hours || "4", 10)));
    const now = nowUtc();
    const until = addHours(now, hours);

    const cacheKey = `pred:${hours}:${Math.floor(now.getTime() / CACHE_TTL_MS)}`;
    if (_cache.data && _cache.key === cacheKey && now.getTime() - _cache.t < CACHE_TTL_MS) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json(_cache.data);
    }

    const d1 = new Date(now);
    const yyyy = d1.getUTCFullYear();
    const mm = String(d1.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d1.getUTCDate()).padStart(2, "0");
    const today = `${yyyy}-${mm}-${dd}`;

    const headers = { "x-apisports-key": API_KEY };
    const fxUrlToday = `${API_BASE}/fixtures?date=${today}`;
    const rToday = await safeJsonFetch(fxUrlToday, { headers });
    if (!rToday.ok) {
      res.setHeader("Content-Type", "application/json");
      return res.status(502).json({ ok: false, error: "fixtures fetch failed", detail: rToday, football: [] });
    }
    let fixtures = Array.isArray(rToday.data?.response) ? rToday.data.response : [];

    if (until.getUTCDate() !== now.getUTCDate()) {
      const d2 = new Date(until);
      const yyyy2 = d2.getUTCFullYear();
      const mm2 = String(d2.getUTCMonth() + 1).padStart(2, "0");
      const dd2 = String(d2.getUTCDate()).padStart(2, "0");
      const tomorrow = `${yyyy2}-${mm2}-${dd2}`;
      const fxUrlTom = `${API_BASE}/fixtures?date=${tomorrow}`;
      const rTom = await safeJsonFetch(fxUrlTom, { headers });
      if (rTom.ok && Array.isArray(rTom.data?.response)) {
        fixtures = fixtures.concat(rTom.data.response);
        const seen = new Set();
        fixtures = fixtures.filter(f => {
          const id = f?.fixture?.id;
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      }
    }

    const startTs = now.getTime();
    const endTs = until.getTime();
    const within = fixtures.filter(f => {
      const iso = f?.fixture?.date;
      const ts = iso ? new Date(iso).getTime() : 0;
      return ts >= startTs && ts <= endTs;
    });

    const shortList = within.slice(0, MAX_PRED_FIXTURES);

    const predictions = [];
    for (const fx of shortList) {
      const fid = fx?.fixture?.id;
      if (!fid) continue;
      const pUrl = `${API_BASE}/predictions?fixture=${fid}`;
      const pr = await safeJsonFetch(pUrl, { headers });
      if (!pr.ok || !Array.isArray(pr.data?.response) || pr.data.response.length === 0) continue;
      const shaped = shapePredictionItem(fx, pr.data.response[0]);
      predictions.push(shaped);
    }

    predictions.sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0));

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      window_hours: hours,
      count: predictions.length,
      football: predictions,
    };

    _cache = { t: now.getTime(), key: cacheKey, data: payload };

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(payload);
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({ ok: false, error: String(e?.message || e), football: [] });
  }
}
