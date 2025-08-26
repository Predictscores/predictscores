// pages/api/history-check.js
// Settluje rezultate, normalizuje imena timova i kvote (bez BASE_URL)

export default async function handler(req, res) {
  try {
    const days = parseInt(req.query.days || "3", 10);

    const r = await fetch(`https://predictscores.vercel.app/api/history?days=${days}`);
    if (!r.ok) return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    const raw = await r.json();

    const fixed = (raw.history || []).map((h) => {
      const out = { ...h };

      // imena timova – fallback varijante
      out.home_name = h?.teams?.home?.name || h?.home_name || h?.home || "Unknown";
      out.away_name = h?.teams?.away?.name || h?.away_name || h?.away || "Unknown";

      // closing odds decimal – u dozvoljenim granicama
      let odds =
        h?.closing_odds_decimal || h?.closing_odds || h?.market_odds || h?.odds;
      odds = Number(odds);
      if (!Number.isFinite(odds) || odds < 1.01 || odds > 20) odds = null;
      out.closing_odds_decimal = odds;

      return out;
    });

    res.status(200).json({ ok: true, days, history: fixed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
