// pages/api/cron/rebuild.js
// Kreira zaključane slotove (AM / PM / LATE) sa filtrima i ban listom

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

      // kvote u granicama
      const dec = normalizeOdds(m?.market_odds);
      if (!dec) return false;

      // kickoff validan
      const dt = m?.datetime_local?.starting_at?.date_time || m?.datetime_local?.date_time;
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
