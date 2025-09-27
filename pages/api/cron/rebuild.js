// pages/api/cron/rebuild.js
// Hybrid, quota-safe rebuild:
// 1) Prefer KV sources (vbl_full:<ymd>:<slot> -> vbl_full:<ymd> -> snapshot -> union).
// 2) If still empty, make ONE fixtures call to API-Football for today.
// 3) Write compact snapshot/union for downstream steps.
// Time-bounded, no hanging.

import * as kvlib from '../../../lib/kv-read';

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

function normalizeFixture(fx) {
  const fixture = fx?.fixture || fx || {};
  const league = fx?.league || {};
  const teams = fx?.teams || {};
  return {
    id: fixture?.id ?? fx?.id ?? null,
    league: {
      id: league?.id ?? null,
      name: league?.name ?? null,
      country: league?.country ?? null,
      season: league?.season ?? null,
      tier: league?.tier ?? null,
    },
    fixture: {
      date: fixture?.date ?? null,
      timestamp: fixture?.timestamp ?? null,
      timezone: fixture?.timezone ?? null,
      venue: fixture?.venue ?? null,
      status: fixture?.status ?? null,
    },
    teams: {
      home: { id: teams?.home?.id ?? null, name: teams?.home?.name ?? null },
      away: { id: teams?.away?.id ?? null, name: teams?.away?.name ?? null },
    },
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
    `vb:day:${ymd}:snapshot`,
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

  const url = `https://v3.api-football.com/fixtures?date=${encodeURIComponent(ymd)}`;
  const res = await fetch(url, { headers: { 'x-apisports-key': apiKey }, signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`fixtures fetch failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const arr = Array.isArray(json?.response) ? json.response : [];
  return { items: arr.map(normalizeFixture), source: 'api-football' };
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

    // 2) If still empty, one external fetch (bounded by MAX_MS)
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

    // 4) Persist compact snapshot & union for today
    const ts = new Date().toISOString();
    const snapshotKey = `vb:day:${ymd}:snapshot`;
    const unionKey = `vb:day:${ymd}:union`;
    await kv.set(snapshotKey, JSON.stringify({ ymd, slot, ts, items: unique, source: sourceKey || fetchedSource || 'kv-only' }));
    await kv.set(unionKey, JSON.stringify({ ymd, slot, ts, items: unique.map(x => x.id), source: sourceKey || fetchedSource || 'kv-only' }));

    const elapsed = Date.now() - started;
    res.status(200).json({
      ok: true,
      ymd, slot,
      counts: { full: items.length, processed: unique.length, updated: 0 },
      source: sourceKey || fetchedSource || 'kv-only',
      timed_out: elapsed >= MAX_MS || fetchedSource === 'timeout',
      stop_reason: (elapsed >= MAX_MS || fetchedSource === 'timeout') ? 'time' : 'done',
      snapshotKey, unionKey,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  } finally {
    clearTimeout(t);
  }
}
