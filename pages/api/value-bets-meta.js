// pages/api/value-bets-meta.js
// Read-only “meta view”: vraća iste stavke kao /api/value-bets-locked,
// prilaže meta (stats/injuries/H2H) ako postoji u KV,
// i OPCIONO (query ?enrich=1) računa BLAGU korekciju confidence-a (±1–3 p.p.).
// Ne menja broj/izbor parova; ništa ne piše u KV; potpuno bezbedno.

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

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Mikro-korekcije na osnovu META (bezbedno, vrlo skromno)
function computeAdjPP(item, meta) {
  if (!meta || typeof item?.confidence_pct !== "number") return 0;

  const market = String(item?.market || "").toUpperCase();
  const pick = String(item?.pick_code || item?.selection_code || "").toUpperCase();

  const injH = Number(meta?.injuries?.homeCount || 0);
  const injA = Number(meta?.injuries?.awayCount || 0);
  const injTotal = injH + injA;

  let adj = 0;

  // Ako je dosta povreda ukupno, malo smanji "agresivne" ishode:
  // - OU2.5 Over i BTTS Yes dobijaju najveći minus (manje golova očekujemo)
  // - 1X2 dobijaju neznatan minus zbog neizvesnosti
  if (injTotal >= 4) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 2;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 2;
    if (market === "1X2" && (pick === "1" || pick === "2" || pick === "X")) adj -= 1;
  } else if (injTotal >= 2) {
    if (market === "OU2.5" && pick === "O2.5") adj -= 1;
    if (market === "BTTS" && (pick === "Y" || pick === "YES")) adj -= 1;
    // 1X2 ne diramo za “light” povrede
  }

  // H2H signal zasad ne koristimo (u meti imamo samo count, bez distribucija) — bezbedno.

  // Ograniči korekciju na [-3, +3] p.p.
  return clamp(adj, -3, 3);
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    const wantEnrich = String(req.query?.enrich || "0") === "1";
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    // 1) Uzimamo zaključane pickove iz postojeće rute (ne diramo je)
    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const vb = await r.json();
    const items = Array.isArray(vb?.items) ? vb.items : [];
    const ymd = String(vb?.ymd || ymdBelgrade());

    // Ako nema stavki — samo prosledi original
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

      // Ako je traženo enrich=1, primeni vrlo blage korekcije (±1–3 p.p.) — bezbedno
      if (wantEnrich && typeof it?.confidence_pct === "number") {
        const adj = computeAdjPP(it, meta);
        if (adj !== 0) {
          const baseConf = Number(it.confidence_pct) || 0;
          const newConf = clamp(baseConf + adj, 30, 85); // čisto da ne ode u ekstrem
          out.push({
            ...it,
            confidence_pct_adj: newConf,
            meta: { ...(meta || {}), confidence_adj_pp: adj, applied: true },
          });
          adjusted++;
          continue;
        }
      }

      // Default: bez promene confidence-a, samo priključi meta ako postoji
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
