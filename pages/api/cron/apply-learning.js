// pages/api/cron/apply-learning.js
// Calls impl and ALSO returns probe counts for snapshot/vbl_full/union (no new endpoints).

import * as kvlib from '../../../lib/kv-read';
import applyLearningImpl from './apply-learning.impl';

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
function parseMaybeJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { /* ignore */ } }
  return raw;
}
async function readArr(kv, key) {
  const raw = await kv.get(key);
  const doc = parseMaybeJson(raw);
  if (!doc) return [];
  return Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
}

export default async function handler(req, res) {
  try {
    const kv = await getKvClient();
    const now = new Date();
    const ymd = ymdUTC(now);
    const slot = belgradeSlot(now);

    // Probes to confirm what exists in KV
    const snapshotKey = `vb:day:${ymd}:snapshot`;
    const unionKey    = `vb:day:${ymd}:union`;
    const vblSlotKey  = `vbl_full:${ymd}:${slot}`;
    const vblDayKey   = `vbl_full:${ymd}`;

    const probe_snapshot_len = (await readArr(kv, snapshotKey)).length;
    const probe_union_arr    = await readArr(kv, unionKey);
    const probe_union_len    = probe_union_arr.length && typeof probe_union_arr[0] !== 'object'
                               ? probe_union_arr.length
                               : probe_union_arr.map(x => (x?.fixture?.id ?? x?.id)).filter(Boolean).length;
    const probe_vbl_slot_len = (await readArr(kv, vblSlotKey)).length;
    const probe_vbl_day_len  = (await readArr(kv, vblDayKey)).length;

    // Publish
    const out = await applyLearningImpl({ kv, todayYmd: ymd });

    res.status(200).json({
      ...out,
      probes: {
        snapshotKey, unionKey, vblSlotKey, vblDayKey,
        snapshot_len: probe_snapshot_len,
        union_len: probe_union_len,
        vbl_slot_len: probe_vbl_slot_len,
        vbl_day_len: probe_vbl_day_len,
      }
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
