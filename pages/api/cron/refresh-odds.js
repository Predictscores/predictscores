// pages/api/cron/refresh-odds.js
// "Osvežava" prozor kvota – praktično greje cache i validira trusted bookies.

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

    // Uzmi širi prozor mečeva da zagreje cache i osveži kvote.
    const r = await fetch(`${ROOT}/api/football?hours=24`);
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    }
    const data = await r.json();

    // Blaga validacija: banuj youth/rezervne/women, uzmi samo trusted bookies i sane kvote.
    let okItems = 0;
    for (const m of data.football || []) {
      if (BAN_REGEX.test(m?.league?.name || "")) continue;

      const books = (m.books_used || []).map((b) => String(b).toLowerCase());
      if (books.length === 0) continue;
      if (!books.every((b) => trusted.has(b))) continue;

      const dec = normalizeOdds(m?.market_odds);
      if (!dec) continue;

      okItems++;
    }

    return res.status(200).json({
      ok: true,
      checked: Array.isArray(data.football) ? data.football.length : 0,
      valid: okItems,
      note: "odds window refreshed",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
