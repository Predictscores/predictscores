// pages/api/cron/enrich.js
// Enrichment za zaključane predloge (stats / injuries / H2H -> meta u KV)
// SADA: uvek upišemo meta zapis (stub) čak i kad fale ID/season,
//       kako bi value-bets-meta mogla da prikači `meta` za sve stavke.
// Bezbedno: ne menja liste; samo piše meta ključeve.

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
// Preferiramo write token; ako ga nema, probaće sa RO (Upstash će odbiti, ali bez lomljenja)
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
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    // 1) Zaključani pickovi iz postojeće rute (ne diramo je)
    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const data = await r.json().catch(() => ({ items: [] }));
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      return res.status(200).json({ ok: true, slot, ymd, enriched: 0, reason: "no-items" });
    }

    let enriched = 0;        // ukupno zapisanih meta (stub + full)
    let enriched_full = 0;   // meta sa povučenim podacima (stats/inj/h2h)
    let stubbed = 0;         // stub meta kad fale ID/season
    const metaKeys = [];
    const metaListKey = `vb:meta:list:${ymd}:${slot}`;

    // 2) Obrada svakog picka
    for (const p of items) {
      try {
        const fixture_id = p?.fixture_id;
        const homeId = p?.teams?.home_id || p?.home_id;
        const awayId = p?.teams?.away_id || p?.away_id;
        const leagueId = p?.league?.id || p?.league_id;
        const season = p?.league?.season || p?.season;

        // Osnovni “header” meta zapisa (uvek prisutan)
        const baseMeta = {
          ts: Date.now(),
          market: p?.market,
          pick_code: p?.pick_code,
          teams: { homeId, awayId },
          leagueId,
          season,
        };

        // Ako nema fixture_id — ne možemo stabilno da indeksiramo -> preskačemo
        if (!fixture_id) continue;

        let meta;
        if (!homeId || !awayId || !leagueId || !season) {
          // 2a) STUB meta (fale identifikatori/season)
          meta = {
            ...baseMeta,
            reason: "missing_ids",
            stats: { haveHome: false, haveAway: false },
            injuries: { homeCount: 0, awayCount: 0 },
            h2h: { have: false, count: 0 },
            confidence_adj_pp: 0,
          };
          const ok = await kvSet(`vb:meta:${ymd}:${slot}:${fixture_id}`, meta);
          if (ok) { enriched++; stubbed++; metaKeys.push(`vb:meta:${ymd}:${slot}:${fixture_id}`); }
          continue;
        }

        // 2b) Puni enrichment (sa wrapper-om: keš + budžet)
        const [statsH, statsA, injH, injA, h2h] = await Promise.all([
          afxTeamStats(leagueId, homeId, season).catch(() => null),
          afxTeamStats(leagueId, awayId, season).catch(() => null),
          afxInjuries(homeId).catch(() => null),
          afxInjuries(awayId).catch(() => null),
          afxH2H(homeId, awayId, 10).catch(() => null),
        ]);

        meta = {
          ...baseMeta,
          stats: { haveHome: !!statsH, haveAway: !!statsA },
          injuries: {
            homeCount: Array.isArray(injH?.response) ? injH.response.length : 0,
            awayCount: Array.isArray(injA?.response) ? injA.response.length : 0,
          },
          h2h: {
            have: !!(Array.isArray(h2h?.response) && h2h.response.length),
            count: Array.isArray(h2h?.response) ? h2h.response.length : 0,
          },
          confidence_adj_pp: 0,
        };

        const ok = await kvSet(`vb:meta:${ymd}:${slot}:${fixture_id}`, meta);
        if (ok) { enriched++; enriched_full++; metaKeys.push(`vb:meta:${ymd}:${slot}:${fixture_id}`); }
      } catch (_) {
        // tiho preskoči pojedinačni fail
      }
    }

    // 3) Zapiši listu meta ključeva radi debug-a (ako išta imamo)
    if (enriched && metaKeys.length) {
      await kvSet(metaListKey, { ymd, slot, keys: metaKeys, n: metaKeys.length, ts: Date.now() });
    }

    return res.status(200).json({
      ok: true,
      slot,
      ymd,
      enriched,        // ukupno meta zapisa (stub + full)
      enriched_full,   // koliko je imalo pune podatke
      stubbed,         // koliko je bilo stubova
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
