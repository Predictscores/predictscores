// pages/api/cron/apply-learning.js
// Calls the impl and returns probe counts for both legacy and chunked snapshot sources.

import * as kvlib from '../../../lib/kv-read';
import applyLearningImpl from './apply-learning.impl';

async function getKvClient() {
  if (typeof kvlib.getKV === 'function') {
    const c = await kvlib.getKV();
    if (c && typeof c.get === 'function' && typeof c.set === 'function') return c;
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
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch {} }
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

    // Probes (both legacy and chunked)
    const snapshotKeyLegacy = `vb:day:${ymd}:snapshot`;
    const unionKey          = `vb:day:${ymd}:union`;
    const vblSlotKey        = `vbl_full:${ymd}:${slot}`;
    const vblDayKey         = `vbl_full:${ymd}`;
    const indexKey          = `vb:day:${ymd}:snapshot:index`;

    const legacySnapLen = (await readArr(kv, snapshotKeyLegacy)).length;
    const unionArr      = await readArr(kv, unionKey);
    const unionLen      = unionArr.length && typeof unionArr[0] !== 'object'
                          ? unionArr.length
                          : unionArr.map(x => (x?.fixture?.id ?? x?.id)).filter(Boolean).length;
    const vblSlotLen    = (await readArr(kv, vblSlotKey)).length;
    const vblDayLen     = (await readArr(kv, vblDayKey)).length;

    let chunkedLen = 0;
    const idxRaw = await kv.get(indexKey);
    const idxDoc = parseMaybeJson(idxRaw);
    if (idxDoc && typeof idxDoc.chunks === 'number' && idxDoc.chunks > 0) {
      // Sum lengths of all chunk parts
      for (let i = 0; i < idxDoc.chunks; i++) {
        const part = await readArr(kv, `vb:day:${ymd}:snapshot:${i}`);
        chunkedLen += part.length;
      }
    }

    // Publish
    const out = await applyLearningImpl({ kv, todayYmd: ymd });

    res.status(200).json({
      ...out,
      probes: {
        snapshot_legacy_key: snapshotKeyLegacy,
        snapshot_index_key: indexKey,
        union_key: unionKey,
        vbl_slot_key: vblSlotKey,
        vbl_day_key: vblDayKey,
        snapshot_legacy_len: legacySnapLen,
        snapshot_chunked_len: chunkedLen,
        union_len: unionLen,
        vbl_slot_len: vblSlotLen,
        vbl_day_len: vblDayLen,
      }
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
