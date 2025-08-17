=== lib/sources/apiFootball.js ===
// Safe wrapper for API-FOOTBALL (v3) using the official header.
// Drop-in replacement; avoids RapidAPI headers which can cause 403/HTML.

const API_BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const API_KEY = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || "";

function qs(params = {}) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) v.forEach((vv) => u.append(k, vv));
    else u.append(k, v);
  });
  return u.toString();
}

async function afFetch(path, params = {}, init = {}) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY is missing");
  const url = `${API_BASE}${path}${Object.keys(params).length ? `?${qs(params)}` : ""}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "x-apisports-key": API_KEY,
      Accept: "application/json",
      ...(init.headers || {}),
    },
    // Let platform handle timeouts; this wrapper must not crash callers.
  });
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text();
    throw new Error(`API-FOOTBALL non-JSON response (${res.status}): ${text.slice(0, 180)}`);
  }
  const data = await res.json();
  return data;
}

module.exports = {
  afFetch,
  default: { afFetch },
};


=== pages/api/value-bets-locked.js ===
// Returns the locked daily shortlist (up to VB_LIMIT), with smart fallback rules per SWE-45 brief.
// Key changes:
// 1) After 10:00 Europe/Belgrade, if there is no snapshot for today -> return EMPTY (no day fallback).
// 2) Pre 10:00, night mini-feed is OPTIONAL (behind FEATURE_NIGHT_MINIFEED=1). Otherwise empty.
// 3) Ensures teams.home.name / teams.away.name and a `match` string are always present.
// 4) Includes lightweight calibration read from vb:learn:calib:latest (display only; ranking untouched).

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const CDN_SMAX = parseInt(process.env.CDN_SMAXAGE_SEC || "600", 10);
const CDN_STALE = parseInt(process.env.CDN_STALE_SEC || "120", 10);

function setCDN(res) {
  res.setHeader(
    "Cache-Control",
    `public, max-age=60, s-maxage=${CDN_SMAX}, stale-while-revalidate=${CDN_STALE}`
  );
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}

function fmtDate(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .replace(/\//g, "-");
}

function localParts(d = new Date(), tz = TZ) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(d)
    .reduce((acc, x) => ((acc[x.type] = x.value), acc), {});
  return { h: parseInt(p.hour, 10), m: parseInt(p.minute, 10), s: parseInt(p.second, 10) };
}

function normalizeItem(p, calib) {
  const isoLocal = p?.datetime_local?.starting_at?.date_time || p?.kickoff || null;
  const kickoffIso = isoLocal ? String(isoLocal).replace(" ", "T").replace(/Z?$/, "") : null;

  const homeName = p?.teams?.home?.name || p?.teams?.home || p?.home_team_name || "Home";
  const awayName = p?.teams?.away?.name || p?.teams?.away || p?.away_team_name || "Away";

  const teams = {
    home: { id: p?.teams?.home?.id ?? null, name: String(homeName) },
    away: { id: p?.teams?.away?.id ?? null, name: String(awayName) },
  };

  const league = p?.league || {};

  // Read-only calibration (display only)
  const marketKey = String(p?.market || "").toUpperCase();
  const leagueName = league?.name || p?.league_name || "";
  const marketDelta = calib?.market?.[marketKey]?.delta_pp ?? 0;
  const leagueDelta = calib?.league?.[marketKey]?.[leagueName]?.delta_vs_market_pp ?? 0;

  const out = {
    ...p,
    teams,
    match: `${teams.home.name} vs ${teams.away.name}`,
    league,
    kickoff: kickoffIso,
    calibMarketPP: Math.max(-5, Math.min(5, marketDelta)),
    calibLeaguePP: Math.max(-8, Math.min(8, leagueDelta)),
  };
  return out;
}

export default async function handler(req, res) {
  try {
    setCDN(res);
    const now = new Date();
    const today = fmtDate(now, TZ); // YYYY-MM-DD
    const { h } = localParts(now, TZ);

    // Always try to read calibration; non-fatal if missing
    let calib = null;
    try {
      const raw = await kvGet("vb:learn:calib:latest");
      if (raw) calib = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (_) {}

    // Read today's snapshot
    const raw = await kvGet(`vb:day:${today}:last`);
    const snap = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

    if (Array.isArray(snap) && snap.length) {
      // Respect VB_LIMIT + per-league was already applied at build time
      const value_bets = snap.slice(0, VB_LIMIT).map((x) => normalizeItem(x, calib));
      return res.status(200).json({ value_bets, built_at: new Date().toISOString(), day: today, source: "locked-cache" });
    }

    // No snapshot exists yet
    if (h < 10) {
      // Before 10:00 local: optional night mini-feed (behind flag) else empty
      if (process.env.FEATURE_NIGHT_MINIFEED === "1") {
        const nightRaw = await kvGet(`vb:night:${today}:preview`);
        const preview = nightRaw ? (typeof nightRaw === "string" ? JSON.parse(nightRaw) : nightRaw) : [];
        const value_bets = (preview || []).slice(0, Math.min(6, VB_LIMIT)).map((x) => normalizeItem(x, calib));
        return res.status(200).json({ value_bets, built_at: new Date().toISOString(), day: today, source: "preview-night" });
      }
      return res.status(200).json({ value_bets: [], built_at: new Date().toISOString(), day: today, source: "empty-night" });
    }

    // After 10:00 local: per brief, do NOT serve stale/fallback – return empty
    return res.status(200).json({ value_bets: [], built_at: new Date().toISOString(), day: today, source: "empty-no-snapshot" });
  } catch (err) {
    console.error("value-bets-locked error", err);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ value_bets: [], error: String(err?.message || err) });
  }
}


=== pages/api/learning-build.js ===
// Nightly learning/calibration builder.
// Reads last N days of locked snapshots and their FT scores from KV, computes deltas
// between shown confidence and actual win rate per market and per-league.
// Writes summary into vb:learn:calib:latest. Safe even if data is sparse.

const KV_URL2 = process.env.KV_REST_API_URL;
const KV_TOKEN2 = process.env.KV_REST_API_TOKEN;
const TZ2 = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGet2(key) {
  const r = await fetch(`${KV_URL2}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN2}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}

async function kvSet2(key, value) {
  const r = await fetch(`${KV_URL2}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN2}`,
    },
    body: JSON.stringify({ value: typeof value === "string" ? value : JSON.stringify(value) }),
  });
  const j = await r.json().catch(() => null);
  return j?.result === "OK";
}

function fmtDate2(d, tz = TZ2) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .replace(/\//g, "-");
}

function addDays(d, diff) {
  const dd = new Date(d);
  dd.setUTCDate(dd.getUTCDate() + diff);
  return dd;
}

function parseScore(obj) {
  // Expecting something like { ft: { home: n, away: n }, ht: { ... } } or similar.
  // Be defensive.
  try {
    const s = typeof obj === "string" ? JSON.parse(obj) : obj;
    const ft = s?.ft || s?.fulltime || s?.full_time || s?.score || null;
    if (!ft) return null;
    const home = Number(ft.home ?? ft.h ?? ft[0]);
    const away = Number(ft.away ?? ft.a ?? ft[1]);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    return { home, away };
  } catch (_) {
    return null;
  }
}

function resolveOutcome(market, selection, score /* {home,away} */) {
  const m = String(market || "").toUpperCase();
  const sel = String(selection || "").toUpperCase();
  const { home, away } = score;

  if (m === "1X2" || m === "1X2 FT" || m === "FT 1X2") {
    const winner = home > away ? "HOME" : home < away ? "AWAY" : "DRAW";
    const map = { "1": "HOME", "2": "AWAY", X: "DRAW", HOME: "HOME", AWAY: "AWAY", DRAW: "DRAW" };
    return map[sel] === winner;
  }

  if (m.includes("BTTS")) {
    const yes = home > 0 && away > 0;
    const map = { YES: true, NO: false };
    return map[sel] === yes;
  }

  if (m.includes("OVER")) {
    // Try to extract threshold from selection like "Over 2.5" / "OVER_2_5"
    const th = /([0-9]+(?:\.[0-9])?)/.exec(selection)?.[1] || /([0-9]+(?:_[0-9])?)/.exec(selection)?.[1]?.replace("_", ".") || "2.5";
    const limit = Number(th);
    if (!Number.isFinite(limit)) return null;
    return home + away > limit;
  }

  // HT-FT or others -> skip unless we have HT in score (not implemented here)
  return null;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const days = Math.max(1, Math.min(90, parseInt(req.query.days || "30", 10)));
    const today = new Date();

    const samples = [];

    for (let i = 0; i < days; i++) {
      const d = fmtDate2(addDays(today, -i), TZ2);
      const raw = await kvGet2(`vb:day:${d}:last`);
      const snap = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      if (!Array.isArray(snap) || !snap.length) continue;

      for (const p of snap) {
        const market = p?.market || "";
        const conf = Number(p?.confidence ?? p?.confidence_pct ?? p?.conf ?? NaN);
        const lg = p?.league?.name || p?.league_name || "";
        const fid = p?.fixture_id || p?.fixture || p?.id;
        if (!fid || !market || !Number.isFinite(conf)) continue;

        const scRaw = await kvGet2(`vb:score:${fid}`);
        const sc = parseScore(scRaw);
        if (!sc) continue;

        const ok = resolveOutcome(market, p?.selection || p?.selectionLabel, sc);
        if (ok === null) continue; // unsupported market/selection

        samples.push({ market: String(market).toUpperCase(), league: lg, conf: Math.max(0, Math.min(100, conf)), win: !!ok });
      }
    }

    // Aggregate
    const aggMarket = {}; // { [m]: { wins, total, confSum } }
    const aggLeague = {}; // { [m]: { [league]: { wins, total } } }

    for (const s of samples) {
      aggMarket[s.market] ||= { wins: 0, total: 0, confSum: 0 };
      aggMarket[s.market].wins += s.win ? 1 : 0;
      aggMarket[s.market].total += 1;
      aggMarket[s.market].confSum += s.conf;

      aggLeague[s.market] ||= {};
      aggLeague[s.market][s.league] ||= { wins: 0, total: 0 };
      aggLeague[s.market][s.league].wins += s.win ? 1 : 0;
      aggLeague[s.market][s.league].total += 1;
    }

    // Laplace smoothing and deltas
    const out = { market: {}, league: {} };
    for (const [m, v] of Object.entries(aggMarket)) {
      const wr = (v.wins + 1) / (v.total + 2); // Laplace (1,1)
      const avgConf = v.confSum / Math.max(1, v.total) / 100; // 0..1
      out.market[m] = { delta_pp: Math.round((wr - avgConf) * 1000) / 10 }; // one decimal pp
    }

    for (const [m, leagues] of Object.entries(aggLeague)) {
      out.league[m] ||= {};
      for (const [lg, v] of Object.entries(leagues)) {
        const wr = (v.wins + 1) / (v.total + 2);
        const base = out.market[m]?.delta_pp ?? 0; // compare to market-level delta
        // league vs market adjustment (approx): difference of WR from avgConf is already captured at market-level
        out.league[m][lg] = { delta_vs_market_pp: Math.round((wr * 100 - Math.max(0, Math.min(100, (v.wins / Math.max(1, v.total)) * 100))) * 10) / 10 };
      }
    }

    await kvSet2("vb:learn:calib:latest", out);

    return res.status(200).json({ ok: true, days, samples: samples.length, wrote: "vb:learn:calib:latest" });
  } catch (err) {
    console.error("learning-build error", err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
