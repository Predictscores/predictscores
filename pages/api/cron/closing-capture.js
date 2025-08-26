// pages/api/cron/closing-capture.js
// "Closing" capture oko KO – povlači aktuelne mečeve i čuva samo validne/trusted kvote.

const ROOT = "https://predictscores.vercel.app"; // hardkodovan base da ne zavisi od ENV
const BAN_REGEX = /(U21|U23|Development|Youth|Women|Girls)/i;

function parseTrusted() {
  const list = (process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

function normalizeOdds(o) {
  if (!o) return null;
  const n = Number(o);
  if (!Number.isFinite(n)) return null;
  if (n < 1.01 || n > 20) return null;
  return n;
}

export default async function handler(_req, res) {
  try {
    const trusted = parseTrusted();

    // Uži prozor – oko KO (6h je dovoljno da uhvatimo pre/posle).
    const r = await fetch(`${ROOT}/api/football?hours=6`);
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    }
    const data = await r.json();

    let captured = 0;
    for (const m of data.football || []) {
      if (BAN_REGEX.test(m?.league?.name || "")) continue;

      const books = (m.books_used || []).map((b) => String(b).toLowerCase());
      if (books.length === 0) continue;
      if (!books.every((b) => trusted.has(b))) continue;

      const dec = normalizeOdds(m?.market_odds);
      if (!dec) continue;

      captured++;
      // Ovde bi u tvojoj kompletnoj verziji išlo: upis u KV / DB kao "closing_odds_decimal"
      // Pošto radimo "no-deps" i bez pristupa tvojoj bazi, ostavljamo kao validacijski capture.
    }

    return res.status(200).json({
      ok: true,
      inspected: Array.isArray(data.football) ? data.football.length : 0,
      captured,
      note: "closing odds window processed",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
