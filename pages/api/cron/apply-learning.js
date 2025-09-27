// pages/api/cron/apply-learning.js
// Purpose: read today's UNION & chunked snapshot, freeze today's picks into vbl_* keys,
// write history, and expose a freshness marker for odds watcher.

export const config = { api: { bodyParser: false } };

/* ---------- timezone / slot ---------- */
function belgradeYMD(d = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(d);
  }
}
function inferSlotByTime(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hour12: false });
  const [H] = fmt.format(d).split(":").map(Number);
  if (H < 10) return "late";
  if (H < 15) return "am";
  return "pm";
}

/* ---------- KV helpers ---------- */
const KV_URL = process.env.KV_REST_API_URL?.replace(/\/+$/, "");
const KV_TOK = process.env.KV_REST_API_TOKEN;
const okKV = !!(KV_URL && KV_TOK);
const J = (s) => { try { return JSON.parse(String(s || "")); } catch { return null; } };

async function kvGet(key) {
  if (!okKV) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOK}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvSet(key, val) {
  if (!okKV) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body: typeof val === "string" ? val : JSON.stringify(val),
  });
  return r.ok;
}

/* ---------- normalization ---------- */
function normalizeIds(maybe) {
  if (!maybe) return [];
  if (Array.isArray(maybe)) {
    const ids = [];
    for (const x of maybe) {
      if (x == null) continue;
      if (typeof x === "number" || typeof x === "string") { ids.push(Number(x) || String(x)); continue; }
      if (typeof x === "object") {
        const id = x.id ?? x.fixture_id ?? x.fixture?.id;
        if (id != null) ids.push(Number(id) || String(id));
      }
    }
    return Array.from(new Set(ids));
  }
  if (typeof maybe === "object") {
    return normalizeIds(maybe.items || maybe.fixtures || []);
  }
  return [];
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    if (!okKV) return res.status(200).json({ ok: false, error: "KV not configured" });

    const now = new Date();
    const ymd = String(req.query.ymd || belgradeYMD(now));
    const qSlot = String(req.query.slot || "").toLowerCase();
    const slot = (qSlot === "am" || qSlot === "pm" || qSlot === "late") ? qSlot : inferSlotByTime(now);

    // Keys
    const snapshotLegacyKey = `vb:day:${ymd}:snapshot`;
    const snapshotIndexKey  = `vb:day:${ymd}:snapshot:index`;
    const unionKey          = `vb:day:${ymd}:union`;
    const vblSlotKey        = `vbl_full:${ymd}:${slot}`;
    const vblDayKey         = `vbl_full:${ymd}`;
    const historyKey        = `vb:history:${ymd}`;
    const lockKey           = `vb:day:${ymd}:last`;
    const vbLockedTodayKey  = `vb-locked:kv:hit:${ymd}`;
    const vbLockedMarker    = `vb-locked:kv:hit`; // global freshness marker (odds watcher reads this)

    // Probes
    const [snapLegacyRaw, snapIdxRaw, unionRaw, vblSlotRaw, vblDayRaw] = await Promise.all([
      kvGet(snapshotLegacyKey), kvGet(snapshotIndexKey), kvGet(unionKey), kvGet(vblSlotKey), kvGet(vblDayKey)
    ]);

    const snapshotsLegacy = J(snapLegacyRaw) || snapLegacyRaw || null;
    const snapshotsIndex  = J(snapIdxRaw) || snapIdxRaw || null;
    const unionData       = J(unionRaw);
    const ids = normalizeIds(unionData);

    const probes = {
      snapshot_legacy_key: snapshotLegacyKey,
      snapshot_index_key:  snapshotIndexKey,
      union_key:           unionKey,
      vbl_slot_key:        vblSlotKey,
      vbl_day_key:         vblDayKey,
      snapshot_legacy_len: Array.isArray(snapshotsLegacy?.items) ? snapshotsLegacy.items.length
                            : Array.isArray(snapshotsLegacy) ? snapshotsLegacy.length
                            : (snapshotsLegacy ? 1 : 0),
      snapshot_chunked_len: Array.isArray(snapshotsIndex?.chunks) ? snapshotsIndex.chunks.length
                             : Array.isArray(snapshotsIndex) ? snapshotsIndex.length
                             : (snapshotsIndex ? 1 : 0),
      union_len:            ids.length,
      vbl_slot_len:         (J(vblSlotRaw)?.items || []).length,
      vbl_day_len:          (J(vblDayRaw)?.items || []).length,
    };

    if (ids.length === 0) {
      // Nothing to learn from; still write lock marker so callers see we ran.
      await kvSet(lockKey, { ymd, slot, ts: new Date().toISOString(), reason: "empty-union" });
      return res.status(200).json({ ok: true, ymd, count: 0, wrote: { lockKey, historyKey }, sourceKey: null, probes });
    }

    // Merge into day & write slot
    const nowIso = new Date().toISOString();
    const slotDoc = { ymd, slot, ts: nowIso, items: ids };
    await kvSet(vblSlotKey, slotDoc);

    let dayDoc = { ymd, ts: nowIso, items: [] };
    const prevDayRaw = await kvGet(vblDayKey);
    if (prevDayRaw) {
      const prev = J(prevDayRaw);
      dayDoc.items = Array.isArray(prev?.items) ? Array.from(new Set([...prev.items, ...ids])) : ids.slice();
    } else {
      dayDoc.items = ids.slice();
    }
    dayDoc.ts = nowIso;
    await kvSet(vblDayKey, dayDoc);

    // History & lock
    await kvSet(historyKey, { ymd, ts: nowIso, items: ids, slot });
    await kvSet(lockKey,    { ymd, ts: nowIso, last_slot: slot, count: ids.length });

    // Freshness markers for odds watcher and feed reader
    const marker = { ymd, ts: nowIso, last_odds_refresh: nowIso, items: ids.length };
    await kvSet(vbLockedTodayKey, marker);
    await kvSet(vbLockedMarker,   marker);

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      count: ids.length,
      wrote: { vblSlotKey, vblDayKey, historyKey, lockKey, vbLockedTodayKey, vbLockedMarker },
      sourceKey: unionKey,
      probes
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
