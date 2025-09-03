// pages/api/value-bets-meta.js
// Read-only “meta view”: vraća iste stavke kao /api/value-bets-locked,
// ali pokušava da priloži meta podatke (stats/injuries/H2H) za svaki pick.
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

export default async function handler(req, res) {
  try {
    const slot = String(req.query?.slot || "am").toLowerCase();
    const base = process.env.BASE_URL || `https://${req.headers.host || "predictscores.vercel.app"}`;

    // 1) Uzimamo zaključane pickove iz postojeće rute (ne diramo je)
    const r = await fetch(`${base}/api/value-bets-locked?slot=${encodeURIComponent(slot)}`, { cache: "no-store" });
    const vb = await r.json();
    const items = Array.isArray(vb?.items) ? vb.items : [];
    const ymd = String(vb?.ymd || ymdBelgrade());

    // Ako nema KV ili nema stavki — samo prosledi dalje bez meta
    if (!items.length || !KV_BASE || !KV_TOKEN) {
      return res.status(200).json({ ...vb, with_meta: !!(KV_BASE && KV_TOKEN), meta_attached: 0 });
    }

    // 2) Pokušaj da za svaki pick učitaš meta sa ključa vb:meta:<YMD>:<slot>:<fixture_id>
    let attached = 0;
    const out = [];
    for (const it of items) {
      const fixtureId = it?.fixture_id;
      if (fixtureId) {
        const key = `vb:meta:${ymd}:${slot}:${fixtureId}`;
        const meta = await kvGet(key);
        if (meta && typeof meta === "object") {
          out.push({ ...it, meta });
          attached++;
          continue;
        }
      }
      out.push(it); // nema meta — ostavi netaknuto
    }

    // 3) Vrati isti oblik kao locked, uz markere
    return res.status(200).json({
      ...vb,
      items: out,
      with_meta: true,
      meta_attached: attached,
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
