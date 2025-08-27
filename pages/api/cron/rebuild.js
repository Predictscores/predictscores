// pages/api/cron/rebuild.js
// Kreira zaključane slotove (AM / PM / LATE) sa filtrima i ban listom

// HVATA SVE UNDER/REZERVE/ŽENSKE/MLAĐE
const BAN_REGEX =
  /(U-?\d{1,2}\b|\bU\d{1,2}\b|Under\s?\d{1,2}|Reserve|Reserves|B Team|B-Team|\bB$|\bII\b|Youth|Women|Girls|Development|Academy)/i;

// --- helpers ---
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
  // zameni zarez tačkom i ukloni sve sem cifara i tačke
  s = s.replace(",", ".").replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function normalizeOdds(o) {
  const n = toDecimal(o);
  if (!Number.isFinite(n)) return null;
  // MIN KVOTA 1.50, MAX 20
  if (n < 1.5 || n > 20) return null;
  return n;
}

export default async function handler(req, res) {
  try {
    const { slot = "am" } = req.query;
    const trusted = parseTrusted();

    // Hardkodovan base – bez BASE_URL env
    const r = await fetch("https://predictscores.vercel.app/api/football?hours=24");
    if (!r.ok) return res.status(502).json({ ok: false, error: `downstream ${r.status}` });
    const raw = await r.json();

    let items = (raw.football || []).filter((m) => {
      // BAN liga po imenu
      if (BAN_REGEX.test(m?.league?.name || "")) return false;

      // samo trusted bookies
      const books = (m.books_used || []).map((b) => String(b).toLowerCase());
      if (books.length === 0) return false;
      if (!books.every((b) => trusted.has(b))) return false;

      // kvote: preferiraj decimal polja, potom market_odds
      const dec =
        normalizeOdds(m?.closing_odds_decimal) ??
        normalizeOdds(m?.market_odds_decimal) ??
        normalizeOdds(m?.market_odds) ??
        normalizeOdds(m?.odds) ??
        null;
      if (!dec) return false;

      // kickoff validan
      const dt =
        m?.datetime_local?.starting_at?.date_time ||
        m?.datetime_local?.date_time ||
        m?.time?.starting_at?.date_time ||
        m?.kickoff;
      if (!dt || isNaN(new Date(dt).getTime())) return false;

      return true;
    });

    // limit po ligi (cap=3) – možeš povećati na 4–5 po želji
    const perLeague = {};
    items = items.filter((m) => {
      const lid = m.league?.id || m.league?.name || "unknown";
      perLeague[lid] = (perLeague[lid] || 0) + 1;
      return perLeague[lid] <= 3;
    });

    res.status(200).json({ ok: true, slot, count: items.length, football: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
