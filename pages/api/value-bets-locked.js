// pages/api/value-bets-locked.js
// Reads vb:day:<ymd>:last safely, no reliance on getKV() symbol.

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
    const kv = await getKvClient();
    const ymd = ymdUTC();
    const lockKey = `vb:day:${ymd}:last`;

    const raw = await kv.get(lockKey);
    let doc = null;
    try { doc = raw ? JSON.parse(raw) : null; } catch { doc = null; }

    const items = Array.isArray(doc?.items) ? doc.items : [];
    const safe = items.map((it) => ({
      ...it,
      tier: it?.tier ?? it?.league?.tier ?? null
    }));

    res.status(200).json({
      items: safe,
      meta: { ymd, source: doc ? 'vb-locked:kv:hit' : 'vb-locked:kv:miss', ts: doc?.ts ?? null }
    });
  } catch (e) {
    res.status(200).json({ items: [], meta: { error: String(e?.message || e) } });
  }
}
