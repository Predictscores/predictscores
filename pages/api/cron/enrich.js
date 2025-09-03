// pages/api/cron/enrich.js
// Enrichment za zaključane predloge (stats / injuries / H2H -> meta u KV)
// UVEK pišemo meta (stub kad fale ID/season), a kad imamo H2H,
// izračunamo procentualne “hintove” (over2_5_pct, btts_pct, draw_pct).
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

function isFinalStatus(s) {
  const x = String(s || "").toUpperCase();
  return /^FT|AET|PEN$/.test(x);
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
      return res.status(200).json({ ok: true, slot, ymd, enriched: 0, enriched_full: 0, stubbed: 0, reason: "no-items" });
    }

    let enriched = 0;        // ukupno zapisanih meta (stub + full)
    let enriched_full = 0;   // meta sa povučenim podacima (stats/inj/h2h)
    let stubbed = 0;         // stub meta kad fale ID/season
    const metaKeys = [];
    const metaListKey = `vb:meta:list:${ymd}:${slot}`;

    for (const p of items) {
      try {
        const fixture_id = p?.fixture_id;
        const homeId = p?.teams?.home_id || p?.home_id;
        const awayId = p?.teams?.away_id || p?.away_id;
        const leagueId = p?.league?.id || p?.league_id;
        const season = p?.league?.season || p?.season;

        if (!fixture_id) continue; // bez stabilnog ID-a nema ključa

        const baseMeta = {
          ts: Date.now(),
          market: p?.market,
          pick_code: p?.pick_code,
          teams: { homeId, awayId },
          leagueId,
          season,
        };

        // STUB meta ako fale identifikatori
        if (!homeId || !awayId || !leagueId || !season) {
          const meta = {
            ...baseMeta,
            reason: "missing_ids",
            stats: { haveHome: false, haveAway: false },
            injuries: { homeCount: 0, awayCount: 0 },
            h2h: { have: false, count: 0, over2_5_pct: 0, btts_pct: 0, draw_pct: 0 },
            confidence_adj_pp: 0,
          };
          const ok = await kvSet(`vb:meta:${ymd}:${slot}:${fixture_id}`, meta);
          if (ok) { enriched++; stubbed++; metaKeys.push(`vb:meta:${ymd}:${slot}:${fixture_id}`); }
          continue;
        }

        // Puni enrichment
        const [statsH, statsA, injH, injA, h2h] = await Promise.all([
          afxTeamStats(leagueId, homeId, season).catch(() => null),
          afxTeamStats(leagueId, awayId, season).catch(() => null),
          afxInjuries(homeId).catch(() => null),
          afxInjuries(awayId).catch(() => null),
          afxH2H(homeId, awayId, 10).catch(() => null),
        ]);

        // H2H procente računamo lokalno (bezbedno)
        let h2hCount = 0, over25 = 0, btts = 0, draws = 0;
        const H = Array.isArray(h2h?.response) ? h2h.response : [];
        for (const m of H) {
          const st = m?.fixture?.status?.short;
          const gh = Number(m?.goals?.home);
          const ga = Number(m?.goals?.away);
          if (!isFinalStatus(st) || !Number.isFinite(gh) || !Number.isFinite(ga)) continue;
          h2hCount++;
          if (gh + ga >= 3) over25++;
          if (gh > 0 && ga > 0) btts++;
          if (gh === ga) draws++;
        }
        const pct = (num, den) => (den > 0 ? Math.round((100 * num) / den) : 0);

        const meta = {
          ...baseMeta,
          stats: { haveHome: !!statsH, haveAway: !!statsA }, // i dalje lagano; ne uvlačimo celu statistiku
          injuries: {
            homeCount: Array.isArray(injH?.response) ? injH.response.length : 0,
            awayCount: Array.isArray(injA?.response) ? injA.response.length : 0,
          },
          h2h: {
            have: h2hCount > 0,
            count: h2hCount,
            over2_5_pct: pct(over25, h2hCount),
            btts_pct: pct(btts, h2hCount),
            draw_pct: pct(draws, h2hCount),
          },
          confidence_adj_pp: 0,
        };

        const ok = await kvSet(`vb:meta:${ymd}:${slot}:${fixture_id}`, meta);
        if (ok) { enriched++; enriched_full++; metaKeys.push(`vb:meta:${ymd}:${slot}:${fixture_id}`); }
      } catch {
        // tiho preskoči pojedinačni fail
      }
    }

    if (enriched && metaKeys.length) {
      await kvSet(metaListKey, { ymd, slot, keys: metaKeys, n: metaKeys.length, ts: Date.now() });
    }

    return res.status(200).json({ ok: true, slot, ymd, enriched, enriched_full, stubbed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
