// pages/api/value-bets-locked.js
// Drop-in: returns today's locked list; never crashes on missing tier; includes basic meta.

import { getKV } from '../../lib/kv-read'; // keep your existing helper path

export default async function handler(req, res) {
  try {
    const kv = await getKV();
    const ymd = new Date().toISOString().slice(0,10);
    const lockKey = `vb:day:${ymd}:last`;

    const raw = await kv.get(lockKey);
    let doc = null;
    try { doc = raw ? JSON.parse(raw) : null; } catch { doc = null; }

    const items = Array.isArray(doc?.items) ? doc.items : [];
    const safe = items.map((it) => ({
      ...it,
      tier: it?.tier ?? it?.league?.tier ?? null
    }));

    return res.status(200).json({
      items: safe,
      meta: {
        ymd,
        source: doc ? 'vb-locked:kv:hit' : 'vb-locked:kv:miss',
        ts: doc?.ts ?? null
      }
    });
  } catch (e) {
    return res.status(200).json({ items: [], meta: { error: String(e?.message || e) } });
  }
}
