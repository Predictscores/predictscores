// Returns the locked daily shortlist (up to VB_LIMIT), with smart fallback rules per SWE-45 brief.
//
// Ključne izmene:
// 1) Posle 10:00 (Europe/Belgrade), ako ne postoji snapshot za danas -> vraćamo PRAZNO (nema dnevnog fallbacka).
// 2) Pre 10:00: noćni mini-feed je opcion (FEATURE_NIGHT_MINIFEED=1), inače prazno.
// 3) Garantujemo teams.home.name / teams.away.name i `match` string.
// 4) Dodajemo lightweight kalibraciju iz vb:learn:calib:latest (samo prikaz; ne menja rang).

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
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
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
  return {
    h: parseInt(p.hour, 10),
    m: parseInt(p.minute, 10),
    s: parseInt(p.second, 10),
  };
}

function normalizeItem(p, calib) {
  const isoLocal = p?.datetime_local?.starting_at?.date_time || p?.kickoff || null;
  const kickoffIso = isoLocal ? String(isoLocal).replace(" ", "T").replace(/Z?$/, "") : null;

  const homeName =
    p?.teams?.home?.name || p?.teams?.home || p?.home_team_name || "Home";
  const awayName =
    p?.teams?.away?.name || p?.teams?.away || p?.away_team_name || "Away";

  const teams = {
    home: { id: p?.teams?.home?.id ?? null, name: String(homeName) },
    away: { id: p?.teams?.away?.id ?? null, name: String(awayName) },
  };

  const league = p?.league || {};
  const marketKey = String(p?.market || "").toUpperCase();
  const leagueName = league?.name || p?.league_name || "";

  const marketDelta = calib?.market?.[marketKey]?.delta_pp ?? 0;
  const leagueDelta =
    calib?.league?.[marketKey]?.[leagueName]?.delta_vs_market_pp ?? 0;

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

    // Pokušaj da pročitaš kalibraciju (non-fatal)
    let calib = null;
    try {
      const rawCal = await kvGet("vb:learn:calib:latest");
      if (rawCal) calib = typeof rawCal === "string" ? JSON.parse(rawCal) : rawCal;
    } catch (_) {}

    // Pročitaj današnji snapshot zaključanih (25)
    const raw = await kvGet(`vb:day:${today}:last`);
    const snap = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

    if (Array.isArray(snap) && snap.length) {
      const value_bets = snap
        .slice(0, VB_LIMIT)
        .map((x) => normalizeItem(x, calib));
      return res
        .status(200)
        .json({
          value_bets,
          built_at: new Date().toISOString(),
          day: today,
          source: "locked-cache",
        });
    }

    // Nema snapshota
    if (h < 10) {
      // Pre 10:00 — opcion noćni mini-feed
      if (process.env.FEATURE_NIGHT_MINIFEED === "1") {
        const nightRaw = await kvGet(`vb:night:${today}:preview`);
        const preview =
          nightRaw ? (typeof nightRaw === "string" ? JSON.parse(nightRaw) : nightRaw) : [];
        const value_bets = (preview || [])
          .slice(0, Math.min(6, VB_LIMIT))
          .map((x) => normalizeItem(x, calib));
        return res
          .status(200)
          .json({
            value_bets,
            built_at: new Date().toISOString(),
            day: today,
            source: "preview-night",
          });
      }
      return res
        .status(200)
        .json({
          value_bets: [],
          built_at: new Date().toISOString(),
          day: today,
          source: "empty-night",
        });
    }

    // Posle 10:00 — po brief-u nema dnevnog fallbacka
    return res
      .status(200)
      .json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day: today,
        source: "empty-no-snapshot",
      });
  } catch (err) {
    console.error("value-bets-locked error", err);
    res.setHeader("Cache-Control", "no-store");
    return res
      .status(200)
      .json({ value_bets: [], error: String(err?.message || err) });
  }
}
