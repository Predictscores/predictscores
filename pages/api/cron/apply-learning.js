// pages/api/cron/apply-learning.js
// Thin route that loads impl, builds the date, and passes a KV client (with adapter).

import * as kvlib from '../../../lib/kv-read';

async function getKvClient() {
  // Support both shapes: getKV() OR {kvGet, kvSet}
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

function ymdUTC(d = new Date()) {
  // Use UTC to be stable within Actions; UI/slots can still be Belgrade-aware elsewhere
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  try {
    const impl = (await import('./apply-learning.impl.js')).default;
    if (typeof impl !== 'function') throw new Error('apply-learning impl export is not a function');

    const kv = await getKvClient();
    const todayYmd = ymdUTC();

    const out = await impl({ kv, todayYmd });
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ ok: false, error: { phase: 'import/run', message: String(e?.message || e) } });
  }
}
