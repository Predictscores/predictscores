// pages/api/cron/refresh-odds.js
// Osvežava window kvota; poštuje TRUSTED_BOOKIES i BAN_REGEX

const ROOT = "https://predictscores.vercel.app";
const BAN_REGEX = /(U21|U23|U19|U18|U17|Reserve|Reserves|B Team|B-Team|\bB$|\bII\b|Youth|Women|Girls|Development|Academy|U-\d{2}|\bU\d{2}\b)/i;

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

    const r = await fetch(`${ROOT}/api/football?hours=24`);
    if (!r.ok) return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    const data = await r.json();

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

    res.status(200).json({
      ok: true,
      checked: Array.isArray(data.football) ? data.football.length : 0,
      valid: okItems,
      note: "odds window refreshed",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
