// pages/api/history.js
// Returns last N days; falls back to vb:day:<ymd>:last if vb:history:<ymd> is missing.

import * as kvlib from '../../lib/kv-read';

async function getKvClient() {
  if (typeof kvlib.getKV === 'function') {
    const client = await kvlib.getKV();
    if (client && typeof client.get === 'function' && typeof client.set === 'function') return client;
  }
  const kvGet = kvlib.kvGet || kvlib.get;
  const kvSet = kvlib.kvSet || kvlib.set;
  if (typeof kvGet === 'function' && typeof kvSet === 'function') {
    return { get: kvGet, set: kvSet };
  }
  throw new Error('KV adapter: neither getKV() nor kvGet/kvSet found in lib/kv-read');
}

function ymdUTC(d = new Date()) { return d.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  try {
    const daysReq = parseInt(req.query.days || '14', 10);
    const days = Math.min(Math.max(isNaN(daysReq) ? 14 : daysReq, 1), 30);

    const kv = await getKvClient();
    const out = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setUTCDate(now.getUTCDate() - i);
      const ymd = ymdUTC(d);

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
            if (Array.isArray(doc?.items)) payload = { items: doc.items, ymd };
          } catch { /* ignore */ }
        }
      }

      const items = Array.isArray(payload?.items) ? payload.items.map((it) => ({
        id: it?.id ?? null,
        league: it?.league ?? null,
        home: it?.home ?? null,
        away: it?.away ?? null,
        ko: it?.ko ?? null,
        market: it?.market ?? null,
        pick: it?.pick ?? null,
        odds: it?.odds ?? null,
        confidence: it?.confidence ?? null,
        tier: it?.tier ?? it?.league?.tier ?? null
      })) : [];

      out.push({ ymd, items });
    }

    res.status(200).json({ days, history: out });
  } catch (e) {
    res.status(200).json({ days: 0, history: [], error: String(e?.message || e) });
  }
}
