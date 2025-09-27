// pages/api/history.js
// Drop-in: returns last N days (default 14) by reading vb:history:<ymd>,
// and gracefully falls back to vb:day:<ymd>:last if history is missing.

import { getKV } from '../../lib/kv-read';

const fmtYmd = (d) => d.toISOString().slice(0,10);

export default async function handler(req, res) {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '14', 10) || 14, 1), 30);
    const kv = await getKV();

    const out = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = fmtYmd(d);

      const hKey = `vb:history:${ymd}`;
      const lKey = `vb:day:${ymd}:last`;

      let payload = null;
      const rawH = await kv.get(hKey);
      if (rawH) {
        try { payload = JSON.parse(rawH); } catch { payload = null; }
      }

      if (!payload || !Array.isArray(payload.items)) {
        const rawL = await kv.get(lKey);
        if (rawL) {
          try {
            const doc = JSON.parse(rawL);
            if (Array.isArray(doc?.items)) {
              payload = { items: doc.items, ymd };
            }
          } catch { /* ignore */ }
        }
      }

      const items = Array.isArray(payload?.items) ? payload.items.map((it) => ({
        id: it.id ?? null,
        league: it.league ?? null,
        home: it.home ?? null,
        away: it.away ?? null,
        ko: it.ko ?? null,
        market: it.market ?? null,
        pick: it.pick ?? null,
        odds: it.odds ?? null,
        confidence: it.confidence ?? null,
        tier: it.tier ?? it?.league?.tier ?? null
      })) : [];

      out.push({ ymd, items });
    }

    return res.status(200).json({ days, history: out });
  } catch (e) {
    return res.status(200).json({ days: 0, history: [], error: String(e?.message || e) });
  }
}
