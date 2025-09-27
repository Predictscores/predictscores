// pages/api/value-bets-locked.js
// Reads today's canonical lock, and exposes a freshness stamp that workflows can use
// to enforce cooldown. Compatible with both legacy and new freshness keys.
//
// Legacy keys it can read (if your refresh-odds writes them):
//   - vb:last-odds
//   - vb:last-odds:<slot>
// Newer keys (if present):
//   - vb:last_odds_refresh
//   - vb:last_odds_refresh:<slot>

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
  // Europe/Belgrade local hour (approx via UTC offset; precise tz rules not needed for coarse slotting)
  const belgrade = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Belgrade' }));
  const H = belgrade.getHours();
  if (H < 10) return 'late';       // 00:00–09:59
  if (H < 15) return 'am';         // 10:00–14:59
  return 'pm';                     // 15:00–23:59
}

function parseMaybeJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* maybe a plain timestamp string */ }
  }
  return raw;
}

async function readFreshness(kv, slot) {
  // Prefer newer keys
  const keysNew = [`vb:last_odds_refresh:${slot}`, `vb:last_odds_refresh`];
  for (const k of keysNew) {
    const raw = await kv.get(k);
    const doc = parseMaybeJson(raw);
    if (doc && (doc.ts || doc.timestamp)) {
      return { ts: doc.ts || doc.timestamp, slot: doc.slot || slot, updated: doc.updated ?? null, source: k };
    }
  }
  // Fallback to legacy keys (may be a plain ISO string)
  const keysLegacy = [`vb:last-odds:${slot}`, `vb:last-odds`];
  for (const k of keysLegacy) {
    const raw = await kv.get(k);
    if (typeof raw === 'string' && raw.length >= 10) {
      return { ts: raw, slot, updated: null, source: k };
    }
    const doc = parseMaybeJson(raw);
    if (doc && (doc.ts || doc.timestamp)) {
      return { ts: doc.ts || doc.timestamp, slot, updated: doc.updated ?? null, source: k };
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

    const slot = belgradeSlot();
    const freshness = await readFreshness(kv, slot);

    res.status(200).json({
      items: safe,
      meta: {
        ymd,
        source: doc ? 'vb-locked:kv:hit' : 'vb-locked:kv:miss',
        ts: doc?.ts ?? null,
        last_odds_refresh: freshness // { ts, slot, updated, source } | null
      }
    });
  } catch (e) {
    res.status(200).json({ items: [], meta: { error: String(e?.message || e) } });
  }
}
