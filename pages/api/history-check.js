// pages/api/history-check.js
// Settluje rezultate, normalizuje imena timova i kvote (bez dodatnih paketa)

export default async function handler(req, res) {
  try {
    const days = parseInt(req.query.days || "3", 10);

    const raw = await fetch(`${process.env.BASE_URL}/api/history?days=${days}`).then((r) =>
      r.json()
    );

    const fixed = (raw.history || []).map((h) => {
      const out = { ...h };

      // uvek imena timova (fallback varijante)
      out.home_name =
        h?.teams?.home?.name ||
        h?.home_name ||
        h?.home ||
        "Unknown";
      out.away_name =
        h?.teams?.away?.name ||
        h?.away_name ||
        h?.away ||
        "Unknown";

      // closing odds normalizacija
      let odds =
        h?.closing_odds_decimal ||
        h?.closing_odds ||
        h?.market_odds ||
        h?.odds;
      odds = Number(odds);
      if (!isFinite(odds) || odds < 1.01 || odds > 20) {
        odds = null;
      }
      out.closing_odds_decimal = odds;

      return out;
    });

    res.status(200).json({
      ok: true,
      days,
      history: fixed,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
