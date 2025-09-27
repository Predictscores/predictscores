// pages/api/cron/rebuild.js
// KV-only rebuild: DOES NOT call external APIs.
// It gathers today's candidates from keys written by refresh-odds (vbl_full:*),
// falls back to yesterday if needed, and writes compact snapshot/union for downstream steps.

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
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* ignore */ }
  }
  return raw;
}

function normalizeFixture(fx) {
  // Minimal, stable shape for downstream steps
  const fixture = fx?.fixture || {};
  const teams = fx?.teams || {};
  return {
    id: fixture?.id ?? fx?.id ?? null,
    league: {
      id: fx?.league?.id ?? null,
      name: fx?.league?.name ?? null,
      country: fx?.league?.country ?? null,
      season: fx?.league?.season ?? null,
      tier: fx?.league?.tier ?? null,
    },
    fixture: {
      date: fixture?.date ?? fx?.date ?? null,
      timestamp: fixture?.timestamp ?? null,
      timezone: fixture?.timezone ?? null,
      venue: fixture?.venue ?? null,
      status: fixture?.status ?? null,
    },
    teams: {
      home: { id: teams?.home?.id ?? null, name: teams?.home?.name ?? null },
      away: { id: teams?.away?.id ?? null, name: teams?.away?.name ?? null },
    },
    // carry through any odds/enrichment fields if present
    market: fx?.market ?? null,
    pick: fx?.pick ?? null,
    odds: fx?.odds ?? null,
    confidence: fx?.confidence ?? fx?.conf ?? null,
    tier: fx?.tier ?? fx?.league?.tier ?? null,
  };
}

async function readVblFullFor(kv, ymd, slot) {
  const tryKeys = [
    `vbl_full:${ymd}:${slot}`,
    `vbl_full:${ymd}`, // some setups store without slot
  ];
  for (const k of tryKeys) {
    const raw = await kv.get(k);
    const doc = parseMaybeJson(raw);
    if (!doc) continue;
    const arr = Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
    if (arr.length) return { key: k, items: arr };
  }
  return { key: null, items: [] };
}

export default async function handler(req, res) {
  try {
    const kv = await getKvClient();
    const now = new Date();
    const ymd = ymdUTC(now);
    const slot = (req.query.slot === 'am' || req.query.slot === 'pm' || req.query.slot === 'late')
      ? req.query.slot
      : belgradeSlot(now);

    // 1) Prefer today's vbl_full (enriched by refresh-odds)
    let { key: sourceKey, items } = await readVblFullFor(kv, ymd, slot);

    // 2) If empty, fall back to yesterday's vbl_full
    if (!items.length) {
      const yest = new Date(now); yest.setUTCDate(now.getUTCDate() - 1);
      const ymdPrev = ymdUTC(yest);
      const prev = await readVblFullFor(kv, ymdPrev, slot);
      if (prev.items.length) {
        sourceKey = prev.key;
        items = prev.items;
      }
    }

    // 3) Normalize & dedupe by fixture id
    const norm = items.map(normalizeFixture).filter(x => x?.id);
    const seen = new Set();
    const unique = [];
    for (const x of norm) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      unique.push(x);
    }

    // 4) Write standard snapshot/union keys for today
    const snapshotKey = `vb:day:${ymd}:snapshot`;
    const unionKey = `vb:day:${ymd}:union`;
    const ts = new Date().toISOString();

    await kv.set(snapshotKey, JSON.stringify({ ymd, slot, ts, items: unique, source: sourceKey || 'kv-only' }));
    await kv.set(unionKey, JSON.stringify({ ymd, slot, ts, items: unique.map(x => x.id), source: sourceKey || 'kv-only' }));

    res.status(200).json({
      ok: true,
      ymd,
      slot,
      counts: { full: items.length, processed: unique.length, updated: 0 },
      source: sourceKey || 'kv-only',
      timed_out: false,
      stop_reason: 'done',
      snapshotKey,
      unionKey,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
