// pages/api/cron/odds-watcher.js
// Periodično proverava i normalizuje kvote na aktivnim mečevima.

const ROOT = "https://predictscores.vercel.app"; // hardkodovan base
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

    // watcher – npr. 4h unapred
    const r = await fetch(`${ROOT}/api/football?hours=4`);
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    }
    const data = await r.json();

    let inspected = 0;
    let valid = 0;

    for (const m of data.football || []) {
      inspected++;
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

      valid++;
      // opcionalno: KV/alert ako kvota “iskoči”
    }

    return res.status(200).json({
      ok: true,
      inspected,
      valid,
      note: "odds watcher executed",
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
