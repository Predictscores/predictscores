// pages/api/cron/apply-learning.impl.js
// Writes canonical vb:day:<ymd>:last and vb:history:<ymd> so History tab has data.
// It tries to source a "final" list from several likely keys; if none found, it keeps [] safely.

function normalizeItem(it) {
  const fixture = it?.fixture || it;
  return {
    id: fixture?.id ?? it?.id ?? null,
    league: it?.league?.name ?? it?.league ?? fixture?.league?.name ?? null,
    home: it?.home?.name ?? it?.home ?? fixture?.teams?.home?.name ?? null,
    away: it?.away?.name ?? it?.away ?? fixture?.teams?.away?.name ?? null,
    ko: it?.ko ?? it?.datetime ?? fixture?.date ?? null,
    market: it?.market ?? it?.selectionType ?? null,
    pick: it?.pick ?? it?.selection ?? null,
    odds: it?.odds ?? it?.price ?? null,
    confidence: it?.confidence ?? it?.conf ?? null,
    tier: it?.tier ?? it?.league?.tier ?? null,
  };
}

async function readFirstNonEmpty(kv, keys) {
  for (const k of keys) {
    const raw = await kv.get(k);
    if (!raw) continue;
    try {
      const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const arr = Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
      if (arr.length) return { key: k, items: arr };
    } catch {
      // ignore malformed; try next
    }
  }
  return { key: null, items: [] };
}

export default async function applyLearningImpl({ kv, todayYmd }) {
  // Try a few common keys that earlier steps may have produced in your pipeline.
  const candidatesKeys = [
    `vb:candidates:${todayYmd}:final`,
    `vb:day:${todayYmd}:final`,
    `vb:day:${todayYmd}:snapshot`,
    `vb:work:${todayYmd}:final`,
    `vb:work:${todayYmd}:scored`,
    `vb:day:${todayYmd}:last`, // fallback to previous lock if it existed
  ];

  const { key: sourceKey, items } = await readFirstNonEmpty(kv, candidatesKeys);
  const normalized = (items || []).map(normalizeItem);

  // 1) Canonical daily lock (UI source)
  const lockKey = `vb:day:${todayYmd}:last`;
  const lockDoc = { items: normalized, ymd: todayYmd, ts: new Date().toISOString(), sourceKey: sourceKey || null };
  await kv.set(lockKey, JSON.stringify(lockDoc));

  // 2) History snapshot for the day
  const historyKey = `vb:history:${todayYmd}`;
  await kv.set(historyKey, JSON.stringify({ items: normalized, ymd: todayYmd }));

  // 3) Minimal tier telemetry (optional debug)
  const t = { t1: 0, t2: 0, t3: 0, nullish: 0 };
  for (const x of normalized) {
    if (x.tier === 1) t.t1++; else if (x.tier === 2) t.t2++; else if (x.tier === 3) t.t3++; else t.nullish++;
  }
  await kv.set(`vb:telemetry:tiers:${todayYmd}`, JSON.stringify({ ...t, total: normalized.length, ymd: todayYmd }));

  return { ok: true, ymd: todayYmd, count: normalized.length, wrote: { lockKey, historyKey }, sourceKey: sourceKey || null };
}
