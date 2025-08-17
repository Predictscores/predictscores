// pages/api/value-bets-locked.js
// Locked feed sa "self-heal" mehanizmom (bez novih fajlova):
// - Ako snapshot za danas postoji -> vraća ga normalno (sa CDN cache).
// - Ako je PRE 10:00 CET -> opcion noćni mini-feed (FEATURE_NIGHT_MINIFEED=1), inače prazno.
// - Ako je POSLE 10:00 CET i snapshot NE postoji:
//      * proveri cooldown u KV (vb:ensure:cooldown:<YYYY-MM-DD>, npr. 600s)
//      * ako NEMA cooldown -> setuj ga i ASINHRONO "poguraj" rebuild (oba okidača)
//      * vrati prazan odgovor sa source:"ensure-started" (ili "ensure-wait" ako je cooldown aktivan)
//      * header je no-store da sledeći refresh ne padne u CDN cache
//
// Env (Production):
//   KV_REST_API_URL, KV_REST_API_TOKEN (obavezno)
//   TZ_DISPLAY=Europe/Belgrade
//   VB_LIMIT=25 (default 25)
//   CDN_SMAXAGE_SEC=600, CDN_STALE_SEC=120
//   FEATURE_HISTORY=1
//   (opciono) FEATURE_NIGHT_MINIFEED=1  -> koristi vb:night:<YYYY-MM-DD>:preview ako postoji

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const CDN_SMAX = parseInt(process.env.CDN_SMAXAGE_SEC || "600", 10);
const CDN_STALE = parseInt(process.env.CDN_STALE_SEC || "120", 10);

// ---------- helpers ----------
function setCDN(res) {
  res.setHeader(
    "Cache-Control",
    `public, max-age=60, s-maxage=${CDN_SMAX}, stale-while-revalidate=${CDN_STALE}`
  );
}
function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}

// Upstash KV REST: možemo poslati TTL (ex) u telu; ako ga backend ignoriše, samo nema isteka.
async function kvSet(key, value, { ex } = {}) {
  const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
  if (ex) body.ex = ex; // seconds
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  await r.json().catch(() => null);
  return true;
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

// Normalizacija da UI uvek ima imena timova i "match" string
function normalizeItem(p, calib /* optional */) {
  const isoLocal =
    p?.datetime_local?.starting_at?.date_time || p?.kickoff || null;
  const kickoffIso = isoLocal
    ? String(isoLocal).replace(" ", "T").replace(/Z?$/, "")
    : null;

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

  return {
    ...p,
    teams,
    match: `${teams.home.name} vs ${teams.away.name}`,
    league,
    kickoff: kickoffIso,
    // Prikaz kalibracije je "soft" (ne menja rang):
    calibMarketPP: Math.max(-5, Math.min(5, marketDelta)),
    calibLeaguePP: Math.max(-8, Math.min(8, leagueDelta)),
  };
}

// Fire-and-forget poziv na internu rutu (ne čeka se rezultat)
function fireAndForget(url) {
  void fetch(url, { cache: "no-store" }).catch(() => {});
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const now = new Date();
    const today = fmtDate(now, TZ);
    const { h } = localParts(now, TZ);

    // 1) (neobavezno) kalibracija za prikaz
    let calib = null;
    try {
      const rawCal = await kvGet("vb:learn:calib:latest");
      if (rawCal) calib = typeof rawCal === "string" ? JSON.parse(rawCal) : rawCal;
    } catch (_) {}

    // 2) Pročitaj DANAŠNJI snapshot
    const raw = await kvGet(`vb:day:${today}:last`);
    const snap = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

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
      // PRE 10:00 CET: opcion noćni mini-feed ili prazno
      setNoStore(res);

      if (process.env.FEATURE_NIGHT_MINIFEED === "1") {
        const nightRaw = await kvGet(`vb:night:${today}:preview`);
        const preview =
          nightRaw ? (typeof nightRaw === "string" ? JSON.parse(nightRaw) : nightRaw) : [];
        const value_bets = (preview || [])
          .slice(0, Math.min(6, VB_LIMIT))
          .map((x) => normalizeItem(x, calib));
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

    // POSLE 10:00 CET: SELF-HEAL (bez novih fajlova)
    // - globalni cooldown da ne pokrećemo rebuild često
    // - asinhrono poguramo oba okidača (ne čekamo ih)
    // - vraćamo no-store, pa sledeći refresh/prolaz vidi snapshot čim se napiše

    setNoStore(res);

    const cooldownKey = `vb:ensure:cooldown:${today}`;
    const cooling = await kvGet(cooldownKey);

    if (!cooling) {
      await kvSet(cooldownKey, "1", { ex: 600 }); // ~10 min cooldown

      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const proto = req.headers["x-forwarded-proto"] || "https";
      const baseUrl = `${proto}://${host}`;

      // Pogodi oba okidača (koji god da tvoj kod koristi, biće pokrenut)
      fireAndForget(`${baseUrl}/api/cron/rebuild`);
      fireAndForget(`${baseUrl}/api/value-bets-locked?rebuild=1`);

      return res.status(200).json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day: today,
        source: "ensure-started",
      });
    }

    // cooldown aktivan -> sačekaj malo i opet učitaj
    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day: today,
      source: "ensure-wait",
    });
  } catch (err) {
    console.error("value-bets-locked error", err);
    setNoStore(res);
    return res
      .status(200)
      .json({ value_bets: [], error: String(err?.message || err) });
  }
}
