// pages/api/value-bets-meta.js
// Read-only meta view: vraća iste stavke kao /api/value-bets-locked,
// prilaže meta (stats/injuries/H2H) i OPCIONO (query ?enrich=1) računa BLAGU
// korekciju confidence-a (±1–3 p.p.) na osnovu injuries + H2H procenata.
// Ne menja broj/izbor parova; ne piše u KV; potpuno bezbedno.

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
  } catch {
    return null;
  }
}

function ymdBelgrade(d = new Date()) {
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Belgrade" }).slice(0, 10);
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function computeAdjPP(item, meta) {
  if (!meta || typeof item?.confidence_pct !== "number") return 0;

  const market = String(item?.market || "").toUpperCase();
  const pick = String(item?.pick_code || item?.selection_code || "").toUpperCase();

  // --- Injuries signal (kao i ranije) ---
  const injH = Number(meta?.injuries?.homeCount || 0);
  const injA = Number(meta?.injuries?.awayCount || 0);
  const injTotal = injH + injA;

  let adj = 0;
  if (injTotal >= 4) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 2;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 2;
    if (market === "1X2" && (pick === "1" || pick === "2" || pick === "X")) adj -= 1;
  } else if (injTotal >= 2) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 1;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 1;
  }

  // --- H2H procente (NOVO): koristimo ih samo kad imamo ≥4 FT meča ---
  const h2hCnt = Number(meta?.h2h?.count || 0);
  const overPct = Number(meta?.h2h?.over2_5_pct || 0);
  const bttsPct = Number(meta?.h2h?.btts_pct || 0);
  const drawPct = Number(meta?.h2h?.draw_pct || 0);

  if (h2hCnt >= 4) {
    // OU2.5
    if (market === "OU2.5") {
      if (pick === "O2.5") {
        if (overPct >= 70) adj += 2; else if (overPct >= 60) adj += 1;
        if (overPct <= 30) adj -= 2; else if (overPct <= 40) adj -= 1;
      } else if (pick === "U2.5") {
        if (overPct <= 30) adj += 2; else if (overPct <= 40) adj += 1;
        if (overPct >= 70) adj -= 2; else if (overPct >= 60) adj -= 1;
      }
    }
    // BTTS
    if (market === "BTTS") {
      const yes = (pick === "Y" || pick === "YES");
      if (yes) {
        if (bttsPct >= 65) adj += 2; else if (bttsPct >= 55) adj += 1;
        if (bttsPct <= 35) adj -= 2; else if (bttsPct <= 45) adj -= 1;
      } else {
        if (bttsPct <= 35) adj += 2; else if (bttsPct <= 45) adj += 1;
        if (bttsPct >= 65) adj -= 2; else if (bttsPct >= 55) adj -= 1;
      }
    }
    // 1X2 — Draw samo (jer je robustno), ostale ne diramo
    if (market === "1X2" && pick === "X") {
      if (drawPct >= 40) adj += 2; else if (drawPct >= 33) adj += 1;
      if (drawPct <= 20) adj -= 1; // blaga penalizacija ako retko nerešeno
    }
  }

  return clamp(adj, -3, 3);
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    const wantEnrich = String(req.query?.enrich || "0") === "1";
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const vb = await r.json();
    const items = Array.isArray(vb?.items) ? vb.items : [];
    const ymd = String(vb?.ymd || ymdBelgrade());

    if (!items.length) {
      return res.status(200).json({ ...vb, with_meta: !!(KV_BASE && KV_TOKEN), meta_attached: 0, applied_enrich: false });
    }

    let attached = 0, adjusted = 0;
    const out = [];

    for (const it of items) {
      const fixtureId = it?.fixture_id;
      let meta = null;
      if (fixtureId && KV_BASE && KV_TOKEN) {
        const key = `vb:meta:${ymd}:${slot}:${fixtureId}`;
        meta = await kvGet(key);
        if (meta && typeof meta === "object") attached++;
      }

      if (wantEnrich && typeof it?.confidence_pct === "number") {
        const adj = computeAdjPP(it, meta);
        if (adj !== 0) {
          const baseConf = Number(it.confidence_pct) || 0;
          const newConf = clamp(baseConf + adj, 30, 85);
          out.push({
            ...it,
            confidence_pct_adj: newConf,
            meta: { ...(meta || {}), confidence_adj_pp: adj, applied: true },
          });
          adjusted++;
          continue;
        }
      }

      if (meta) out.push({ ...it, meta: { ...meta, applied: false } });
      else out.push(it);
    }

    return res.status(200).json({
      ...vb,
      items: out,
      with_meta: !!(KV_BASE && KV_TOKEN),
      meta_attached: attached,
      applied_enrich: wantEnrich,
      adjusted_count: wantEnrich ? adjusted : 0,
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
