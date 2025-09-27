// pages/api/cron/apply-learning.impl.js
// Reads best-available candidates from KV (vbl_full -> snapshot -> union),
// normalizes them, and writes the canonical lock & history for the UI.

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
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* ignore */ }
  }
  return raw;
}

function normalize(it) {
  const fx = it?.fixture ? it.fixture : it;
  const league = it?.league || fx?.league || {};
  const teams = it?.teams || fx?.teams || {};
  return {
    id: fx?.id ?? it?.id ?? null,
    league: league?.name ?? league ?? null,
    home: teams?.home?.name ?? it?.home ?? null,
    away: teams?.away?.name ?? it?.away ?? null,
    ko: fx?.date ?? it?.ko ?? it?.datetime ?? null,
    market: it?.market ?? null,
    pick: it?.pick ?? it?.selection ?? null,
    odds: it?.odds ?? it?.price ?? null,
    confidence: it?.confidence ?? it?.conf ?? null,
    tier: it?.tier ?? league?.tier ?? null,
  };
}

async function readArrayFrom(kv, key) {
  const raw = await kv.get(key);
  const doc = parseMaybeJson(raw);
  if (!doc) return { key, items: [] };
  const arr = Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
  return { key, items: arr };
}

export default async function applyLearningImpl({ kv, todayYmd }) {
  const now = new Date();
  const ymd = todayYmd || ymdUTC(now);
  const slot = belgradeSlot(now);

  // Priority order: explicit finals -> snapshot -> vbl_full -> union
  const tryKeys = [
    `vb:candidates:${ymd}:final`,
    `vb:day:${ymd}:final`,
    `vb:day:${ymd}:snapshot`,
    `vbl_full:${ymd}:${slot}`,
    `vbl_full:${ymd}`,
    `vb:day:${ymd}:union`,
  ];

  let sourceKey = null;
  let items = [];
  for (const k of tryKeys) {
    const { items: arr } = await readArrayFrom(kv, k);
    if (arr.length) {
      sourceKey = k;
      items = arr;
      break;
    }
  }

  // If union only (id list), try to enrich from vbl_full today/yesterday
  if (sourceKey && sourceKey.endsWith(':union')) {
    const ids = items.filter(Boolean);
    let bank = [];
    for (const cand of [`vbl_full:${ymd}:${slot}`, `vbl_full:${ymd}`]) {
      const { items: arr } = await readArrayFrom(kv, cand);
      if (arr.length) { bank = arr; sourceKey = cand; break; }
    }
    if (bank.length) {
      const idset = new Set(ids);
      items = bank.filter(x => idset.has((x?.fixture?.id ?? x?.id)));
    } else {
      items = []; // nothing to enrich — keep empty
    }
  }

  // Normalize & dedupe
  const mapped = items.map(normalize).filter(x => x?.id);
  const seen = new Set();
  const unique = [];
  for (const x of mapped) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    unique.push(x);
  }

  // Write lock & history
  const lockKey = `vb:day:${ymd}:last`;
  const historyKey = `vb:history:${ymd}`;
  const ts = new Date().toISOString();

  await kv.set(lockKey, JSON.stringify({ items: unique, ymd, ts, sourceKey }));
  await kv.set(historyKey, JSON.stringify({ items: unique, ymd, ts }));

  // Tiny telemetry
  const t = { t1: 0, t2: 0, t3: 0, nullish: 0 };
  for (const x of unique) {
    if (x.tier === 1) t.t1++; else if (x.tier === 2) t.t2++; else if (x.tier === 3) t.t3++; else t.nullish++;
  }
  await kv.set(`vb:telemetry:tiers:${ymd}`, JSON.stringify({ ...t, total: unique.length, ymd, slot }));

  return { ok: true, ymd, count: unique.length, wrote: { lockKey, historyKey }, sourceKey };
}
