// pages/api/cron/apply-learning.impl.js
// Reads best-available candidates (chunked snapshot -> legacy snapshot -> vbl_full -> union)
// Publishes vb:day:<ymd>:last and vb:history:<ymd>.

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
  if (!doc) return { key, items: [] };
  const arr = Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
  return { key, items: arr };
}

async function readChunkedSnapshot(kv, ymd) {
  const indexKey = `vb:day:${ymd}:snapshot:index`;
  const raw = await kv.get(indexKey);
  const idxDoc = parseMaybeJson(raw);
  if (!idxDoc || typeof idxDoc.chunks !== 'number' || idxDoc.chunks < 1) return { key: null, items: [] };
  const total = idxDoc.chunks;
  const all = [];
  for (let i = 0; i < total; i++) {
    const k = `vb:day:${ymd}:snapshot:${i}`;
    const { items } = await readArr(kv, k);
    if (items.length) all.push(...items);
  }
  return { key: indexKey, items: all };
}

function normalize(it) {
  // We saved a slim shape in snapshot; keep output compatible with UI
  const id = it?.id ?? it?.fixture?.id ?? null;
  const leagueName = it?.league?.name ?? it?.league ?? null;
  const tier = it?.league?.tier ?? it?.tier ?? null;
  const home = it?.teams?.home ?? it?.home ?? null;
  const away = it?.teams?.away ?? it?.away ?? null;
  const ko = it?.date ?? it?.fixture?.date ?? it?.ko ?? null;
  return {
    id, league: leagueName, home, away, ko,
    market: it?.market ?? null,
    pick: it?.pick ?? null,
    odds: it?.odds ?? null,
    confidence: it?.confidence ?? it?.conf ?? null,
    tier,
  };
}

export default async function applyLearningImpl({ kv, todayYmd }) {
  const now = new Date();
  const ymd = todayYmd || ymdUTC(now);
  const slot = belgradeSlot(now);

  // 1) Chunked snapshot
  let { key: sourceKey, items } = await readChunkedSnapshot(kv, ymd);

  // 2) Legacy single snapshot
  if (!items.length) {
    const snap = await readArr(kv, `vb:day:${ymd}:snapshot`);
    if (snap.items.length) { sourceKey = snap.key; items = snap.items; }
  }

  // 3) vbl_full
  if (!items.length) {
    const v1 = await readArr(kv, `vbl_full:${ymd}:${slot}`);
    const v2 = !v1.items.length ? await readArr(kv, `vbl_full:${ymd}`) : { items: [] };
    const pick = v1.items.length ? v1 : v2;
    if (pick.items.length) { sourceKey = pick.key; items = pick.items; }
  }

  // 4) union (IDs) — can’t enrich without bank; publish minimal if necessary
  if (!items.length) {
    const u = await readArr(kv, `vb:day:${ymd}:union`);
    if (u.items.length && typeof u.items[0] !== 'object') {
      items = u.items.map((id) => ({ id }));
      sourceKey = u.key;
    }
  }

  // Normalize & dedupe
  const mapped = items.map(normalize).filter(x => x?.id);
  const seen = new Set();
  const unique = [];
  for (const x of mapped) { if (!seen.has(x.id)) { seen.add(x.id); unique.push(x); } }

  // Publish
  const ts = new Date().toISOString();
  const lockKey = `vb:day:${ymd}:last`;
  const historyKey = `vb:history:${ymd}`;
  await kv.set(lockKey, JSON.stringify({ items: unique, ymd, ts, sourceKey }));
  await kv.set(historyKey, JSON.stringify({ items: unique, ymd, ts }));

  // Telemetry
  const t = { t1: 0, t2: 0, t3: 0, nullish: 0 };
  for (const x of unique) {
    if (x.tier === 1) t.t1++; else if (x.tier === 2) t.t2++; else if (x.tier === 3) t.t3++; else t.nullish++;
  }
  await kv.set(`vb:telemetry:tiers:${ymd}`, JSON.stringify({ ...t, total: unique.length, ymd, slot }));

  return { ok: true, ymd, count: unique.length, wrote: { lockKey, historyKey }, sourceKey };
}
