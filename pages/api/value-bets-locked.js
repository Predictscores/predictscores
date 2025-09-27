// pages/api/value-bets-locked.js
// Reads today's lock and exposes a clean freshness stamp (handles double-encoded JSON).

import * as kvlib from '../../lib/kv-read';

async function getKvClient() {
  if (typeof kvlib.getKV === 'function') {
    const client = await kvlib.getKV();
    if (client && typeof client.get === 'function' && typeof client.set === 'function') return client;
  }
  const kvGet = kvlib.kvGet, kvSet = kvlib.kvSet;
  if (typeof kvGet === 'function' && typeof kvSet === 'function') return { get: kvGet, set: kvSet };
  throw new Error('KV adapter: neither getKV() nor kvGet/kvSet found in lib/kv-read');
}

function ymdUTC(d = new Date()) { return d.toISOString().slice(0, 10); }

function belgradeSlot(now = new Date()) {
  const belgrade = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Belgrade' }));
  const H = belgrade.getHours();
  if (H < 10) return 'late';
  if (H < 15) return 'am';
  return 'pm';
}

function parseOnce(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}
function parseTwice(raw) {
  const once = parseOnce(raw);
  if (once && typeof once === 'string') {
    try { return JSON.parse(once); } catch { /* leave as string */ }
  }
  return once;
}

async function readFreshness(kv, slot) {
  const candidates = [
    `vb:last_odds_refresh:${slot}`,
    `vb:last_odds_refresh`,
    `vb:last-odds:${slot}`,
    `vb:last-odds`,
  ];
  for (const k of candidates) {
    const raw = await kv.get(k);
    if (!raw) continue;
    const doc = parseTwice(raw); // handles object, stringified object, or double-stringified
    if (doc && typeof doc === 'object') {
      const ts = doc.ts || doc.timestamp || doc.value?.ts || null;
      const ymd = doc.ymd || null;
      const updated = doc.updated ?? null;
      if (ts) return { ts, ymd, slot: doc.slot || slot, updated, source: k };
    }
    if (typeof doc === 'string' && doc.length >= 10) {
      return { ts: doc, slot, updated: null, source: k };
    }
  }
  return null;
}

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

    const freshness = await readFreshness(kv, belgradeSlot());

    res.status(200).json({
      items: safe,
      meta: {
        ymd,
        source: doc ? 'vb-locked:kv:hit' : 'vb-locked:kv:miss',
        ts: doc?.ts ?? null,
        last_odds_refresh: freshness
      }
    });
  } catch (e) {
    res.status(200).json({ items: [], meta: { error: String(e?.message || e) } });
  }
}
