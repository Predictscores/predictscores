// pages/api/value-bets-locked.js
// Robust locked feed + “self-heal”:
// 1) Pokušaj `:last`
// 2) Ako nema, pokušaj `:rev` → `:rev:<n>` i rekonstruiši `:last`
// 3) Ako i dalje nema, posle 10:00 pokreni self-heal (cooldown)

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
function setNoStore(res) { res.setHeader("Cache-Control", "no-store"); }

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify({
      value: typeof value === "string" ? value : JSON.stringify(value),
    }),
  });
  await r.json().catch(() => null);
  return true;
}

function fmtDate(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d).replace(/\//g, "-");
}
function localParts(d = new Date(), tz = TZ) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return { h: parseInt(p.hour, 10), m: parseInt(p.minute, 10), s: parseInt(p.second, 10) };
}

function tryParse(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : v?.value_bets && Array.isArray(v.value_bets) ? v.value_bets : null;
    } catch { return null; }
  }
  return null;
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
  const marketKey = String(p?.market || "").toUpperCase();
  const leagueName = league?.name || p?.league_name || "";
  const marketDelta = calib?.market?.[marketKey]?.delta_pp ?? 0;
  const leagueDelta = calib?.league?.[marketKey]?.[leagueName]?.delta_vs_market_pp ?? 0;

  return {
    ...p,
    teams,
    match: `${teams.home.name} vs ${teams.away.name}`,
    league,
    kickoff: kickoffIso,
    calibMarketPP: Math.max(-5, Math.min(5, marketDelta)),
    calibLeaguePP: Math.max(-8, Math.min(8, leagueDelta)),
  };
}

function fireAndForget(url) { void fetch(url, { cache: "no-store" }).catch(() => {}); }

export default async function handler(req, res) {
  try {
    const now = new Date();
    const today = fmtDate(now, TZ);
    const { h } = localParts(now, TZ);

    // Load calib (best-effort)
    let calib = null;
    try {
      const rawCal = await kvGet("vb:learn:calib:latest");
      if (rawCal) calib = typeof rawCal === "string" ? JSON.parse(rawCal) : rawCal;
    } catch {}

    // 1) Pokušaj :last
    let raw = await kvGet(`vb:day:${today}:last`);
    let snap = tryParse(raw);

    // 2) Ako nema, pokušaj preko :rev i popravi :last
    if (!Array.isArray(snap) || snap.length === 0) {
      const revRaw = await kvGet(`vb:day:${today}:rev`);
      const rev = revRaw ? Number(revRaw) : NaN;
      if (Number.isFinite(rev) && rev > 0) {
        const r2 = await kvGet(`vb:day:${today}:rev:${rev}`);
        const snap2 = tryParse(r2);
        if (Array.isArray(snap2) && snap2.length) {
          // Rekonstruiši :last da front od sad ima stabilan ključ
          await kvSet(`vb:day:${today}:last`, snap2);
          snap = snap2;
        }
      }
    }

    if (Array.isArray(snap) && snap.length) {
      setCDN(res);
      const value_bets = snap.slice(0, VB_LIMIT).map((x) => normalizeItem(x, calib));
      return res.status(200).json({
        value_bets,
        built_at: new Date().toISOString(),
        day: today,
        source: "locked-cache",
      });
    }

    // 3) Nema snapshota
    if (h < 10) {
      setNoStore(res);
      if (process.env.FEATURE_NIGHT_MINIFEED === "1") {
        const nightRaw = await kvGet(`vb:night:${today}:preview`);
        const preview = tryParse(nightRaw) || [];
        const value_bets = preview.slice(0, Math.min(6, VB_LIMIT)).map((x) => normalizeItem(x, calib));
        return res.status(200).json({
          value_bets,
          built_at: new Date().toISOString(),
          day: today,
          source: "preview-night",
        });
      }
      return res.status(200).json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day: today,
        source: "empty-night",
      });
    }

    // 4) Posle 10:00 – self-heal (cooldown 10min)
    setNoStore(res);
    const cooldownKey = `vb:ensure:cooldown:${today}`;
    const cooling = await kvGet(cooldownKey);

    if (!cooling) {
      await kvSet(cooldownKey, "1"); // i bez ex je ok; ne-kritično
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const proto = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${proto}://${host}`;
      fireAndForget(`${baseUrl}/api/cron/rebuild`);
      fireAndForget(`${baseUrl}/api/value-bets-locked?rebuild=1`);
      return res.status(200).json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day: today,
        source: "ensure-started",
      });
    }

    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day: today,
      source: "ensure-wait",
    });
  } catch (err) {
    console.error("value-bets-locked error", err);
    setNoStore(res);
    return res.status(200).json({ value_bets: [], error: String(err?.message || err) });
  }
}
