// pages/api/cron/refresh-odds.js
// Quota-safe, non-hanging refresh:
// - EARLY EXIT if there are no candidates in KV (so it won't crawl broadly).
// - COOLDOWN via freshness key -> skips if too recent (unless force=1).
// - HARD TIME BUDGET (max_ms) to avoid long runs.
// - PER-RUN CAP (RUN_CAP) to limit API calls.
// - Always writes freshness stamp: vb:last_odds_refresh and vb:last_odds_refresh:<slot>

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

async function readArr(kv, key) {
  const raw = await kv.get(key);
  const doc = parseMaybeJson(raw);
  if (!doc) return [];
  return Array.isArray(doc?.items) ? doc.items : (Array.isArray(doc) ? doc : []);
}

async function readCandidates(kv, ymd, slot) {
  // Prefer union of IDs; fall back to snapshot list of objects
  let ids = [];
  const union = await readArr(kv, `vb:day:${ymd}:union`);
  if (union.length && typeof union[0] !== 'object') {
    ids = union.filter(Boolean);
  } else {
    const snapshot = await readArr(kv, `vb:day:${ymd}:snapshot`);
    ids = snapshot.map(f => (f?.fixture?.id ?? f?.id)).filter(Boolean);
  }
  return Array.from(new Set(ids));
}

async function getFreshness(kv, slot) {
  const keys = [`vb:last_odds_refresh:${slot}`, `vb:last_odds_refresh`];
  for (const k of keys) {
    const raw = await kv.get(k);
    const doc = parseMaybeJson(raw);
    if (doc && (doc.ts || doc.timestamp)) return { key: k, ts: doc.ts || doc.timestamp, updated: doc.updated ?? null };
  }
  return null;
}

async function setFreshness(kv, slot, payload) {
  const base = { ...payload, slot, ymd: ymdUTC(), ts: new Date().toISOString() };
  await kv.set(`vb:last_odds_refresh`, JSON.stringify(base));
  await kv.set(`vb:last_odds_refresh:${slot}`, JSON.stringify(base));
}

export default async function handler(req, res) {
  const started = Date.now();
  const now = new Date();
  const ymd = ymdUTC(now);
  const slot = (['am','pm','late'].includes(req.query.slot)) ? req.query.slot : belgradeSlot(now);

  const MAX_MS = Math.max(20_000, Math.min(120_000, parseInt(req.query.max_ms || '100000', 10) || 100_000));
  const RUN_CAP = Math.max(10, Math.min(300, parseInt(process.env.ODDS_RUN_CAP || '60', 10))); // default 60 fixtures/run
  const COOLDOWN_MINUTES = Math.max(5, Math.min(120, parseInt(process.env.COOLDOWN_MINUTES || '12', 10)));
  const force = String(req.query.force || '0') === '1';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('time-budget'), MAX_MS);

  try {
    const kv = await getKvClient();

    // 0) COOLDOWN
    const fresh = await getFreshness(kv, slot);
    if (!force && fresh?.ts) {
      const last = Date.parse(fresh.ts);
      if (!Number.isNaN(last)) {
        const ageSec = Math.floor((Date.now() - last) / 1000);
        if (ageSec < COOLDOWN_MINUTES * 60) {
          await setFreshness(kv, slot, { updated: 0, reason: 'cooldown-skip' });
          return res.status(200).json({ ok: true, ymd, slot, updated: 0, skipped: 0, items_len: 0, reason: 'cooldown' });
        }
      }
    }

    // 1) CANDIDATES
    const ids = await readCandidates(kv, ymd, slot);
    if (!ids.length) {
      // EARLY EXIT: nothing to refresh → no hanging / no churn
      await setFreshness(kv, slot, { updated: 0, reason: 'no-candidates' });
      return res.status(200).json({ ok: true, ymd, slot, updated: 0, skipped: 0, items_len: 0, reason: 'no-candidates' });
    }

    // 2) Prepare a lookup of today's snapshot (to attach odds back to objects)
    const snapshot = await readArr(kv, `vb:day:${ymd}:snapshot`);
    const byId = new Map(snapshot.map(o => [ (o?.fixture?.id ?? o?.id), o ]));

    // 3) External API setup
    const apiKey =
      process.env.API_FOOTBALL_KEY ||
      process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
      process.env.APIFOOTBALL_KEY || '';
    if (!apiKey) {
      // No key: still stamp freshness to prevent loops
      await setFreshness(kv, slot, { updated: 0, reason: 'no-key' });
      return res.status(200).json({ ok: true, ymd, slot, updated: 0, skipped: ids.length, items_len: ids.length, reason: 'no-key' });
    }

    // 4) Loop with CAP + time budget
    let updated = 0, skipped = 0;
    const keep = []; // items to persist into vbl_full
    for (const id of ids.slice(0, RUN_CAP)) {
      if ((Date.now() - started) >= MAX_MS) break; // time budget
      if (!id) { skipped++; continue; }

      // fetch odds for this fixture (1 call per id)
      const url = `https://v3.api-football.com/odds?fixture=${encodeURIComponent(id)}`;
      let oddsDoc = null;
      try {
        const resp = await fetch(url, { headers: { 'x-apisports-key': apiKey }, signal: controller.signal });
        if (!resp.ok) { skipped++; continue; }
        const json = await resp.json();
        oddsDoc = Array.isArray(json?.response) ? json.response : [];
      } catch (_) {
        skipped++;
        continue;
      }

      const base = byId.get(id) || { id };
      keep.push({ ...base, odds: oddsDoc });
      updated++;
    }

    // 5) Persist enriched items into vbl_full:<ymd>[:<slot>]
    const vblKey = `vbl_full:${ymd}:${slot}`;
    const ts = new Date().toISOString();
    await kv.set(vblKey, JSON.stringify({ ymd, slot, ts, items: keep }));

    // 6) Freshness stamp for cooldown
    await setFreshness(kv, slot, { updated });

    const budget_exhausted = (Date.now() - started) >= MAX_MS || ids.length > RUN_CAP;
    res.status(200).json({
      ok: true, ymd, slot,
      updated, skipped,
      items_len: ids.length,
      budget_exhausted,
      enriched: true,
      persisted: true,
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const timeout = msg.includes('time-budget') || e?.name === 'AbortError';
    // Try to stamp freshness even on timeout, so next run can cooldown/skip
    try {
      const kv = await getKvClient();
      await setFreshness(kv, (['am','pm','late'].includes(req?.query?.slot) ? req.query.slot : belgradeSlot()), { updated: 0, reason: timeout ? 'time' : 'error' });
    } catch { /* ignore */ }
    res.status(200).json({ ok: false, ymd: ymdUTC(), slot: belgradeSlot(), error: msg, timed_out: timeout });
  } finally {
    clearTimeout(timer);
  }
}
