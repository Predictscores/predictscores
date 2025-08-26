// pages/api/cron/rebuild.js
// Kreira zaključane slotove (AM / PM / LATE) sa filtrima i ban listom

import { DateTime } from "luxon";

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
  let val = Number(o);
  if (!isFinite(val)) return null;
  if (val < 1.01 || val > 20) return null;
  return val;
}

export default async function handler(req, res) {
  try {
    const { slot = "am" } = req.query;
    const trusted = parseTrusted();

    // simulacija – u praksi ovde ide fetch ka tvojoj DB ili value-bets generatoru
    const raw = await fetch(`${process.env.BASE_URL}/api/football?hours=24`).then((r) => r.json());

    let items = (raw.football || []).filter((m) => {
      // ban liste liga
      if (BAN_REGEX.test(m?.league?.name || "")) return false;

      // trusted bookies
      const booksUsed = (m.books_used || []).map((b) => String(b).toLowerCase());
      if (booksUsed.length === 0) return false;
      const allTrusted = booksUsed.every((b) => trusted.has(b));
      if (!allTrusted) return false;

      // normalizovane kvote
      const odds = normalizeOdds(m?.market_odds);
      if (!odds) return false;

      // sanity check vremena
      const dt = m?.datetime_local?.starting_at?.date_time;
      if (!dt) return false;
      const start = DateTime.fromSQL(dt, { zone: "Europe/Belgrade" });
      if (!start.isValid) return false;

      return true;
    });

    // limit po ligi (cap = 3)
    const perLeague = {};
    items = items.filter((m) => {
      const lid = m.league?.id;
      if (!lid) return false;
      perLeague[lid] = (perLeague[lid] || 0) + 1;
      return perLeague[lid] <= 3;
    });

    res.status(200).json({
      ok: true,
      slot,
      count: items.length,
      football: items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
