// pages/api/cron/closing-capture.js
// Povlači mečeve oko KO i filtrira kvote po BAN/Trusted/normalize

const ROOT = "https://predictscores.vercel.app";
const BAN_REGEX =
  /(U-?\d{1,2}\b|\bU\d{1,2}\b|Under\s?\d{1,2}|Reserve|Reserves|B Team|B-Team|\bB$|\bII\b|Youth|Women|Girls|Development|Academy)/i;

function parseTrusted() {
  const list = (process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}
function toDecimal(x) {
  if (x === null || x === undefined) return null;
  let s = String(x).trim();
  s = s.replace(",", ".").replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function normalizeOdds(o) {
  const n = toDecimal(o);
  if (!Number.isFinite(n)) return null;
  if (n < 1.5 || n > 20) return null; // MIN 1.50
  return n;
}

export default async function handler(_req, res) {
  try {
    const trusted = parseTrusted();

    const r = await fetch(`${ROOT}/api/football?hours=6`);
    if (!r.ok) return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    const data = await r.json();

    let captured = 0;
    for (const m of data.football || []) {
      if (BAN_REGEX.test(m?.league?.name || "")) continue;

      const books = (m.books_used || []).map((b) => String(b).toLowerCase());
      if (books.length === 0) continue;
      if (!books.every((b) => trusted.has(b))) continue;

      const dec =
        normalizeOdds(m?.closing_odds_decimal) ??
        normalizeOdds(m?.market_odds_decimal) ??
        normalizeOdds(m?.market_odds) ??
        normalizeOdds(m?.odds) ??
        null;
      if (!dec) continue;

      captured++;
      // ovde bi išao upis closing_odds_decimal u KV/DB po tvojoj implementaciji
    }

    res.status(200).json({
      ok: true,
      inspected: Array.isArray(data.football) ? data.football.length : 0,
      captured,
      note: "closing odds window processed",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
