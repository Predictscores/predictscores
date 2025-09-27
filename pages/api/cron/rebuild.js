// pages/api/cron/rebuild.js
// Hybrid + chunked snapshot writer:
// 1) KV-first; if empty, do ONE fixtures fetch for today.
// 2) Normalize & dedupe.
// 3) Write union (IDs) and CHUNKED snapshot under vb:day:<ymd>:snapshot:index and :snapshot:<i>

import * as kvlib from '../../../lib/kv-read';

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

function normalizeFixture(fx) {
  const fixture = fx?.fixture || fx || {};
  const league = fx?.league || {};
  const teams = fx?.teams || {};
  // SLIM shape to keep chunks small
  return {
    id: fixture?.id ?? fx?.id ?? null,
    league: {
      name: league?.name ?? null,
      tier: league?.tier ?? null,
    },
    teams: {
      home: teams?.home?.name ?? null,
      away: teams?.away?.name ?? null,
    },
    date: fixture?.date ?? null,
  };
}

async function readArr(kv, key) {
  const raw = await kv.get(key);
  const doc = parseMaybeJson(raw);
  if (!doc) return [];
  return Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
}

async function loadFromKV(kv, ymd, slot) {
  const order = [
    `vbl_full:${ymd}:${slot}`,
    `vbl_full:${ymd}`,
    `vb:day:${ymd}:snapshot`, // (legacy single-key snapshot; if present we’ll re-chunk it)
    `vb:day:${ymd}:union`,
  ];
  for (const k of order) {
    const arr = await readArr(kv, k);
    if (arr.length) return { sourceKey: k, items: arr };
  }
  return { sourceKey: null, items: [] };
}

async function fetchFixturesOnce(ymd, { signal } = {}) {
  const apiKey =
    process.env.API_FOOTBALL_KEY ||
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.APIFOOTBALL_KEY || '';
  if (!apiKey) return { items: [], source: 'no-key' };

  const url = `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(ymd)}&timezone=Europe/Belgrade`;
  const res = await fetch(url, { headers: { 'x-apisports-key': apiKey }, signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`fixtures fetch failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const arr = Array.isArray(json?.response) ? json.response : [];
  return { items: arr.map(normalizeFixture), source: 'api-football' };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  const started = Date.now();
  const MAX_MS = Math.max(10_000, Math.min(90_000, parseInt(req.query.max_ms || '60000', 10) || 60_000));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort('time-budget'), MAX_MS);

  try {
    const kv = await getKvClient();
    const now = new Date();
    const ymd = ymdUTC(now);
    const slot = (['am', 'pm', 'late'].includes(req.query.slot)) ? req.query.slot : belgradeSlot(now);

    // 1) KV-first
    let { sourceKey, items } = await loadFromKV(kv, ymd, slot);

    // 2) If still empty, one external fetch
    let fetchedSource = null;
    if (!items.length) {
      try {
        const fetched = await fetchFixturesOnce(ymd, { signal: controller.signal });
        items = fetched.items;
        fetchedSource = fetched.source;
      } catch (e) {
        if (!String(e?.message || e).includes('time-budget') && e?.name !== 'AbortError') throw e;
        fetchedSource = 'timeout';
      }
    }

    // 3) Normalize & dedupe
    const norm = items.map(normalizeFixture).filter(x => x?.id);
    const seen = new Set();
    const unique = [];
    for (const x of norm) { if (!seen.has(x.id)) { seen.add(x.id); unique.push(x); } }

    // 4) Write UNION (IDs) small enough to fit in one value
    const unionKey = `vb:day:${ymd}:union`;
    const ts = new Date().toISOString();
    await kv.set(unionKey, JSON.stringify({ ymd, slot, ts, items: unique.map(x => x.id), source: sourceKey || fetchedSource || 'kv-only' }));

    // 5) Write CHUNKED SNAPSHOT
    const indexKey = `vb:day:${ymd}:snapshot:index`;
    const snapshotPrefix = `vb:day:${ymd}:snapshot:`;
    const CHUNK_SIZE = Math.max(200, Math.min(600, parseInt(process.env.SNAPSHOT_CHUNK_SIZE || '400', 10))); // default 400
    const chunks = chunk(unique, CHUNK_SIZE);

    // First, clear any old index (best-effort: just overwrite)
    await kv.set(indexKey, JSON.stringify({ ymd, slot, ts, chunks: chunks.length, size: unique.length }));

    // Write each chunk
    for (let i = 0; i < chunks.length; i++) {
      const key = `${snapshotPrefix}${i}`;
      await kv.set(key, JSON.stringify({ ymd, slot, ts, idx: i, items: chunks[i] }));
    }

    const elapsed = Date.now() - started;
    res.status(200).json({
      ok: true,
      ymd, slot,
      counts: { full: items.length, processed: unique.length, chunks: chunks.length, chunk_size: CHUNK_SIZE },
      source: sourceKey || fetchedSource || 'kv-only',
      timed_out: elapsed >= MAX_MS || fetchedSource === 'timeout',
      stop_reason: (elapsed >= MAX_MS || fetchedSource === 'timeout') ? 'time' : 'done',
      snapshotKey: indexKey,
      unionKey,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  } finally {
    clearTimeout(t);
  }
}
