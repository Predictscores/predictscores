// pages/api/cron/enrich.js
// Enrichment za zaključane predloge (stats / injuries / H2H -> meta u KV)
// Bezbedno: ne menja postojeće liste, samo dodaje meta ključeve.

const { afxTeamStats, afxInjuries, afxH2H } = require("../../../lib/sources/apiFootball");

// --- KV helpers (REST) ---
function toRestBase(s) {
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  const m = s.match(/^rediss?:\/\/(?:[^@]*@)?([^:/?#]+)(?::\d+)?/i);
  if (m) return `https://${m[1]}`;
  return "";
}
const KV_BASE_RAW = (process.env.KV_REST_API_URL || process.env.KV_URL || "").trim();
const KV_BASE = toRestBase(KV_BASE_RAW);
const KV_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || "").trim();

async function kvGet(key) {
  if (!KV_BASE || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_BASE}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const t = await r.text();
    try { return JSON.parse(t); } catch { return null; }
  } catch { return null; }
}
async function kvSet(key, value) {
  if (!KV_BASE || !KV_TOKEN) return false;
  try {
    const r = await fetch(`${KV_BASE}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    return r.ok;
  } catch { return false; }
}

function ymdBelgrade(d = new Date()) {
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Belgrade" }).slice(0, 10);
}

export default async function handler(req, res) {
  try {
    const { slot = "am" } = req.query || {};
    const ymd = ymdBelgrade();

    // 1) Uzmemo zaključane parove iz postojeće rute (najsigurnije, bez nagađanja ključeva)
    const base =
      process.env.BASE_URL ||
      `https://${req.headers.host || "predictscores.vercel.app"}`;
    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const data = await r.json().catch(() => ({ items: [] }));
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      return res.status(200).json({ ok: true, slot, ymd, enriched: 0, reason: "no-items" });
    }

    let enriched = 0;
    const metaListKey = `vb:meta:list:${ymd}:${slot}`;
    const metaKeys = [];

    // 2) Za svaki pick: povuci stats/H2H/injuries (sa TTL kešom iz lib/sources/apiFootball.js)
    for (const p of items) {
      try {
        const fixture_id = p?.fixture_id;
        const homeId = p?.teams?.home_id || p?.home_id;
        const awayId = p?.teams?.away_id || p?.away_id;
        const leagueId = p?.league?.id || p?.league_id;
        const season = p?.league?.season || p?.season;

        if (!fixture_id || !homeId || !awayId || !leagueId || !season) continue;

        // Povuci podatke (wrapper već radi budžet+keš)
        const [statsH, statsA, injH, injA, h2h] = await Promise.all([
          afxTeamStats(leagueId, homeId, season).catch(() => null),
          afxTeamStats(leagueId, awayId, season).catch(() => null),
          afxInjuries(homeId).catch(() => null),
          afxInjuries(awayId).catch(() => null),
          afxH2H(homeId, awayId, 10).catch(() => null),
        ]);

        // 3) Sažetak meta signala (bez agresivne logike – bezbedno)
        const meta = {
          ts: Date.now(),
          market: p?.market,
          pick_code: p?.pick_code,
          teams: { homeId, awayId },
          leagueId, season,
          // samo lightweight info da ne "naduvamo" KV
          stats: {
            haveHome: !!statsH, haveAway: !!statsA,
          },
            // povrede: broj stavki danas (ako API vrati listu)
          injuries: {
            homeCount: Array.isArray(injH?.response) ? injH.response.length : 0,
            awayCount: Array.isArray(injA?.response) ? injA.response.length : 0,
          },
          h2h: {
            have: !!(Array.isArray(h2h?.response) && h2h.response.length),
            count: Array.isArray(h2h?.response) ? h2h.response.length : 0,
          },
          // Za sada samo predlažemo 0 korekciju; u sledećem koraku možemo da dodamo ±1–3 p.p.
          confidence_adj_pp: 0,
        };

        const k = `vb:meta:${ymd}:${slot}:${fixture_id}`;
        const ok = await kvSet(k, meta);
        if (ok) {
          enriched += 1;
          metaKeys.push(k);
        }
      } catch (_) {
        // nastavi dalje, bez bacanja
      }
    }

    // 4) Zapiši listu meta ključeva radi debug-a
    if (enriched && metaKeys.length) {
      await kvSet(metaListKey, { ymd, slot, keys: metaKeys, n: metaKeys.length, ts: Date.now() });
    }

    return res.status(200).json({ ok: true, slot, ymd, enriched });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
