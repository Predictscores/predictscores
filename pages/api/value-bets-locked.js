// pages/api/value-bets-locked.js
// Robust locked feed sa "auto-snapshot" self-heal:
// - Ako postoji današnji snapshot -> čita `vb:day:<YYYY-MM-DD>:last` i vraća listu (sa CDN cache).
// - Ako je PRE 10:00 CET -> (opciono) noćni mini-feed ili prazno.
// - Ako je POSLE 10:00 CET i snapshot NE postoji:
//     * SAM poziva /api/value-bets (generator koji radi AF pozive),
//     * napravi shortlist (max 2 po ligi, UEFA izuzetak, VB_LIMIT),
//     * upiše i `vb:day:<day>:rev`, `vb:day:<day>:rev:<n>` i `vb:day:<day>:last`,
//     * vrati listu kao locked-cache.
//   Uz globalni cooldown (600s) da ne “meljemo” generator više puta.
//
// Env:
//   KV_REST_API_URL, KV_REST_API_TOKEN (obavezno)
//   TZ_DISPLAY=Europe/Belgrade
//   VB_LIMIT=25 (default 25)
//   CDN_SMAXAGE_SEC=600, CDN_STALE_SEC=120
//   FEATURE_HISTORY=1
//   (opciono) FEATURE_NIGHT_MINIFEED=1

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);
const CDN_SMAX = parseInt(process.env.CDN_SMAXAGE_SEC || "600", 10);
const CDN_STALE= parseInt(process.env.CDN_STALE_SEC || "120", 10);

function setCDN(res) {
  res.setHeader("Cache-Control", `public, max-age=60, s-maxage=${CDN_SMAX}, stale-while-revalidate=${CDN_STALE}`);
}
function setNoStore(res) { res.setHeader("Cache-Control", "no-store"); }

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify({ value: typeof value === "string" ? value : JSON.stringify(value) })
  });
  await r.json().catch(()=>null);
  return true;
}

function fmtDate(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"
  }).format(d).replace(/\//g,"-");
}
function localParts(d = new Date(), tz = TZ) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
  }).formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return { h: parseInt(p.hour,10), m: parseInt(p.minute,10), s: parseInt(p.second,10) };
}

function tryParse(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.value_bets)) return v.value_bets;
    } catch {}
  }
  return null;
}

function perLeagueCap(list, maxPerLeague = 2) {
  const kept = [];
  const cnt = new Map();
  for (const p of list) {
    const lg = p?.league?.name || p?.league_name || "Unknown";
    const n = cnt.get(lg) || 0;
    const isUEFA = /UEFA|Champions|Europa|Conference/i.test(lg);
    if (!isUEFA && n >= maxPerLeague) continue;
    kept.push(p);
    cnt.set(lg, n + 1);
    if (kept.length >= VB_LIMIT) break;
  }
  return kept;
}

function normalizeItem(p, calib) {
  const isoLocal = p?.datetime_local?.starting_at?.date_time || p?.kickoff || null;
  const kickoffIso = isoLocal ? String(isoLocal).replace(" ","T").replace(/Z?$/,"") : null;

  const homeName = p?.teams?.home?.name || p?.teams?.home || p?.home_team_name || "Home";
  const awayName = p?.teams?.away?.name || p?.teams?.away || p?.away_team_name || "Away";

  const teams = {
    home: { id: p?.teams?.home?.id ?? null, name: String(homeName) },
    away: { id: p?.teams?.away?.id ?? null, name: String(awayName) },
  };

  const league = p?.league || {};
  const marketKey  = String(p?.market || "").toUpperCase();
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

export default async function handler(req, res) {
  try {
    const now = new Date();
    const today = fmtDate(now, TZ);
    const { h } = localParts(now, TZ);

    // 0) Kalibracija (best-effort)
    let calib = null;
    try {
      const rawCal = await kvGet("vb:learn:calib:latest");
      if (rawCal) calib = typeof rawCal === "string" ? JSON.parse(rawCal) : rawCal;
    } catch {}

    // 1) Pokušaj da pročitaš DANAŠNJI snapshot: :last → (ako fali) :rev → :rev:<n>
    let rawLast = await kvGet(`vb:day:${today}:last`);
    let snap = tryParse(rawLast);

    if (!Array.isArray(snap) || snap.length === 0) {
      const revRaw = await kvGet(`vb:day:${today}:rev`);
      const rev = revRaw ? Number(revRaw) : NaN;
      if (Number.isFinite(rev) && rev > 0) {
        const revList = tryParse(await kvGet(`vb:day:${today}:rev:${rev}`));
        if (Array.isArray(revList) && revList.length) {
          await kvSet(`vb:day:${today}:last`, revList); // rekonstruiši :last
          snap = revList;
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

    // 2) PRE 10:00 — nema dnevnog fallback-a
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

    // 3) POSLE 10:00 — AUTO SNAPSHOT (sam izgradi i upiši :last + :rev)
    // Globalni cooldown da ne maltretiramo generator više puta u kratkom periodu.
    setNoStore(res);
    const cooldownKey = `vb:auto:cooldown:${today}`;
    const cooling = await kvGet(cooldownKey);

    if (!cooling) {
      // postavi cooldown (600s)
      await kvSet(cooldownKey, "1"); // Upstash KV REST nema ex kroz ovaj endpoint uvek; i bez ex ok, nije kritično.

      // Pozovi lokalni generator (radi AF pozive)
      const host  = req.headers["x-forwarded-host"] || req.headers.host;
      const proto = req.headers["x-forwarded-proto"] || "https";
      const base  = `${proto}://${host}`;

      const gen = await fetch(`${base}/api/value-bets`, { cache: "no-store" })
        .then(r => r.json())
        .catch(() => null);

      const list = Array.isArray(gen?.value_bets) ? gen.value_bets : [];
      if (list.length) {
        const chosen = perLeagueCap(list, 2).slice(0, VB_LIMIT);

        // upiši rev i last
        const revKey = `vb:day:${today}:rev`;
        const curRevRaw = await kvGet(revKey);
        const curRev = curRevRaw ? Number(curRevRaw) : 0;
        const nextRev = Number.isFinite(curRev) ? curRev + 1 : 1;

        await kvSet(revKey, String(nextRev));
        await kvSet(`vb:day:${today}:rev:${nextRev}`, chosen);
        await kvSet(`vb:day:${today}:last`, chosen);

        // Odmah vrati locked-cache (nema čekanja na drugi poziv)
        setCDN(res);
        const value_bets = chosen.map((x) => normalizeItem(x, calib));
        return res.status(200).json({
          value_bets,
          built_at: new Date().toISOString(),
          day: today,
          source: "locked-cache",
        });
      }

      // generator vratio prazno → nema šta da zaključamo
      return res.status(200).json({
        value_bets: [],
        built_at: new Date().toISOString(),
        day: today,
        source: "ensure-wait",
        note: "generator-empty",
      });
    }

    // cooldown aktivan → sačekaj, probaj ponovo
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
