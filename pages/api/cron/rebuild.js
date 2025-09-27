// pages/api/cron/rebuild.js
// Rebuilds today's candidate fixtures and writes a compact snapshot to KV.
// - No dependency on any v() helper.
// - Safe time budget and graceful early exit.
// - Minimal shape so refresh-odds + apply-learning can proceed.

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

function ymdUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function belgradeSlot(now = new Date()) {
  const belgrade = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Belgrade' }));
  const H = belgrade.getHours();
  if (H < 10) return 'late'; // 00:00–09:59
  if (H < 15) return 'am';   // 10:00–14:59
  return 'pm';               // 15:00–23:59
}

function normalizeFixture(fx) {
  // Minimal shape consumed by later steps; keep it simple and predictable
  return {
    id: fx?.fixture?.id ?? fx?.id ?? null,
    league: {
      id: fx?.league?.id ?? null,
      name: fx?.league?.name ?? null,
      country: fx?.league?.country ?? null,
      season: fx?.league?.season ?? null,
    },
    fixture: {
      date: fx?.fixture?.date ?? fx?.date ?? null,
      timestamp: fx?.fixture?.timestamp ?? null,
      timezone: fx?.fixture?.timezone ?? null,
      venue: fx?.fixture?.venue ?? null,
      status: fx?.fixture?.status ?? null,
    },
    teams: {
      home: { id: fx?.teams?.home?.id ?? null, name: fx?.teams?.home?.name ?? null },
      away: { id: fx?.teams?.away?.id ?? null, name: fx?.teams?.away?.name ?? null },
    },
  };
}

async function fetchFixturesForDate(ymd, { signal } = {}) {
  // Try both env names people commonly use
  const apiKey =
    process.env.API_FOOTBALL_KEY ||
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.APIFOOTBALL_KEY ||
    '';

  if (!apiKey) {
    // No key → return empty; upstream will still write a snapshot (empty) so the pipeline won’t crash.
    return { items: [], source: 'no-key' };
  }

  const url = `https://v3.api-football.com/fixtures?date=${encodeURIComponent(ymd)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-apisports-key': apiKey },
    signal,
  });

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
  const MAX_MS =
    Math.max(10_000, Math.min(90_000, parseInt(String(req.query.max_ms || ''), 10) || 60_000)); // 10s..90s, default 60s
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('time-budget'), MAX_MS);

  try {
    const kv = await getKvClient();
    const ymd = ymdUTC();
    const slot = (req.query.slot === 'am' || req.query.slot === 'pm' || req.query.slot === 'late')
      ? req.query.slot
      : belgradeSlot();

    // 1) Fetch candidates (bounded by MAX_MS via AbortController)
    let fetched;
    try {
      fetched = await fetchFixturesForDate(ymd, { signal: controller.signal });
    } catch (e) {
      // If aborted by budget, mark as timed out; continue with empty
      if (String(e?.message || e).includes('time-budget') || e?.name === 'AbortError') {
        fetched = { items: [], source: 'timeout' };
      } else {
        throw e;
      }
    }

    const full = Array.isArray(fetched.items) ? fetched.items : [];
    // (Optional light filter: ignore clearly invalid entries)
    const processed = full.filter((fx) => fx?.id && fx?.teams?.home?.name && fx?.teams?.away?.name);

    // 2) Write a compact snapshot the downstream steps expect
    const snapshotKey = `vb:day:${ymd}:snapshot`;
    const unionKey = `vb:day:${ymd}:union`;
    const doc = {
      ymd,
      slot,
      ts: new Date().toISOString(),
      items: processed,
      source: fetched.source,
    };
    await kv.set(snapshotKey, JSON.stringify(doc));
    await kv.set(unionKey, JSON.stringify({ ymd, slot, items: processed.map((x) => x.id), ts: doc.ts }));

    const elapsed = Date.now() - started;
    const timed_out = elapsed >= MAX_MS || fetched.source === 'timeout';

    res.status(200).json({
      ok: true,
      ymd,
      slot,
      counts: {
        full: full.length,
        processed: processed.length,
        updated: processed.length, // placeholder; refresh-odds will compute real odds updates
      },
      source: fetched.source,
      timed_out,
      stop_reason: timed_out ? 'time' : 'done',
      budget_ms: MAX_MS,
      elapsed_ms: elapsed,
      snapshotKey,
      unionKey,
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  } finally {
    clearTimeout(timeout);
  }
}
