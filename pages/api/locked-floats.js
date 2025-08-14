// FILE: pages/api/locked-floats.js
export const config = { api: { bodyParser: false } };

// --- KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: process.env.TZ_DISPLAY || "Europe/Belgrade",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
}

export default async function handler(req, res) {
  try {
    const today = beogradDayKey();
    const snap = await kvGet(`vb:day:${today}:last`);
    if (!Array.isArray(snap) || snap.length === 0) {
      return res.status(200).json({ updated: 0, reason: "no snapshot" });
    }
    const ids = new Set(snap.map(x => x.fixture_id));

    // hit internal /api/value-bets ONCE, then filter to locked fixtures
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const r = await fetch(`${origin}/api/value-bets`, { headers: { "x-locked-floats": "1" } });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: "value-bets fetch failed", details: t });
    }
    const j = await r.json();
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    let updated = 0;
    for (const p of arr) {
      if (!ids.has(p.fixture_id)) continue;
      const odds = Number(p.market_odds);
      const model = Number(p.model_prob); // 0..1
      if (!Number.isFinite(odds) || odds <= 0 || !(model>0 && model<1)) continue;

      const implied = 1 / odds;
      const edge = model - implied;
      const ev = (odds * model) - 1;

      await kvSet(`vb:float:${p.fixture_id}`, {
        as_of: new Date().toISOString(),
        odds,
        implied,
        edge,
        ev,
        confidence: Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null,
        bookmakers_count: p.bookmakers_count ?? null,
        movement_pct: p.movement_pct ?? null
      });
      updated += 1;
    }

    return res.status(200).json({ updated, total_locked: ids.size });
  } catch (e) {
    return res.status(500).json({ error: String(e&&e.message||e) });
  }
}
