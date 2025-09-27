// pages/api/cron/apply-learning.js
// Consumes today's UNION and writes vbl_* + history + freshness marker.
// Reads from BOTH KV backends; writes to BOTH.

export const config = { api: { bodyParser: false } };

/* ---------- TZ & slot ---------- */
function belgradeYMD(d = new Date()) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Belgrade" }).format(d); }
  catch { return new Intl.DateTimeFormat("en-CA").format(d); }
}
function inferSlotByTime(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", minute: "2-digit", hour12: false });
  const [H] = fmt.format(d).split(":").map(Number);
  if (H < 10) return "late";
  if (H < 15) return "am";
  return "pm";
}

/* ---------- Dual KV clients ---------- */
const KV_URL = process.env.KV_REST_API_URL ? String(process.env.KV_REST_API_URL).replace(/\/+$/, "") : "";
const KV_TOK = process.env.KV_REST_API_TOKEN || "";
const hasKV = Boolean(KV_URL && KV_TOK);

const R_URL = process.env.UPSTASH_REDIS_REST_URL ? String(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, "") : "";
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const hasR  = Boolean(R_URL && R_TOK);

const J = (s) => { try { return JSON.parse(String(s ?? "")); } catch { return null; } };

async function kvGetREST(key) {
  if (!hasKV) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOK}` }, cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvSetREST(key, val) {
  if (!hasKV) return false;
  const body = typeof val === "string" ? val : JSON.stringify(val);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOK}`, "Content-Type": "application/json" },
    body,
  });
  return r.ok;
}
async function kvGetUpstash(key) {
  if (!hasR) return null;
  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOK}` }, cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvSetUpstash(key, val) {
  if (!hasR) return false;
  const body = typeof val === "string" ? val : JSON.stringify(val);
  const r = await fetch(`${R_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" },
    body,
  });
  return r.ok;
}
async function kvGetAny(key) {
  const a = await kvGetREST(key);
  if (a != null) return a;
  return kvGetUpstash(key);
}
async function kvSetBoth(key, val) {
  const r1 = await kvSetREST(key, val);
  const r2 = await kvSetUpstash(key, val);
  return r1 || r2;
}

/* ---------- normalize union ---------- */
function normalizeIds(any) {
  if (!any) return [];
  const obj = typeof any === "string" ? J(any) ?? any : any;
  if (Array.isArray(obj)) {
    return Array.from(new Set(obj.map(x => (typeof x === "object" ? (x?.id ?? x?.fixture_id ?? x?.fixture?.id) : x)).filter(Boolean)));
  }
  if (typeof obj === "object") {
    const arr = Array.isArray(obj.items) ? obj.items : (Array.isArray(obj.fixtures) ? obj.fixtures : []);
    return Array.from(new Set(arr.map(x => (typeof x === "object" ? (x?.id ?? x?.fixture_id ?? x?.fixture?.id) : x)).filter(Boolean)));
  }
  return [];
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    if (!hasKV && !hasR) {
      return res.status(200).json({ ok: false, error: "No KV configured (KV_REST_* or UPSTASH_REDIS_REST_*)." });
    }

    const now = new Date();
    const ymd = String(req.query.ymd || belgradeYMD(now));
    const qSlot = String(req.query.slot || "").toLowerCase();
    const slot = (qSlot === "am" || qSlot === "pm" || qSlot === "late") ? qSlot : inferSlotByTime(now);

    // Keys
    const snapshotLegacyKey = `vb:day:${ymd}:snapshot`;
    const snapshotIndexKey  = `vb:day:${ymd}:snapshot:index`;
    const unionKey          = `vb:day:${ymd}:union`;
    const unionObjKey       = `vb:day:${ymd}:union:obj`;
    const vblSlotKey        = `vbl_full:${ymd}:${slot}`;
    const vblDayKey         = `vbl_full:${ymd}`;
    const historyKey        = `vb:history:${ymd}`;
    const lockKey           = `vb:day:${ymd}:last`;
    const vbLockedTodayKey  = `vb-locked:kv:hit:${ymd}`;
    const vbLockedMarker    = `vb-locked:kv:hit`;

    // Probes
    const [snapLegacyRaw, snapIdxRaw, unionRaw, unionObjRaw, vblSlotRaw, vblDayRaw] = await Promise.all([
      kvGetAny(snapshotLegacyKey), kvGetAny(snapshotIndexKey),
      kvGetAny(unionKey), kvGetAny(unionObjKey),
      kvGetAny(vblSlotKey), kvGetAny(vblDayKey),
    ]);

    const snapshotsLegacy = J(snapLegacyRaw) || snapLegacyRaw || null;
    const snapshotsIndex  = J(snapIdxRaw) || snapIdxRaw || null;

    const ids = (() => {
      const a = normalizeIds(unionRaw);
      if (a.length) return a;
      return normalizeIds(unionObjRaw); // mirror written by locked-floats
    })();

    const probes = {
      snapshot_legacy_key: snapshotLegacyKey,
      snapshot_index_key:  snapshotIndexKey,
      union_key:           unionKey,
      union_obj_key:       unionObjKey,
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

    if (!ids.length) {
      await kvSetBoth(lockKey, { ymd, slot, ts: new Date().toISOString(), reason: "empty-union" });
      return res.status(200).json({ ok: true, ymd, count: 0, wrote: { lockKey, historyKey }, sourceKey: null, probes });
    }

    // Write slot + merge day
    const nowIso = new Date().toISOString();
    await kvSetBoth(vblSlotKey, { ymd, slot, ts: nowIso, items: ids });

    let dayItems = ids.slice();
    const prevDayRaw = await kvGetAny(vblDayKey);
    if (prevDayRaw) {
      const prev = J(prevDayRaw);
      if (Array.isArray(prev?.items)) {
        dayItems = Array.from(new Set([...prev.items, ...ids]));
      }
    }
    await kvSetBoth(vblDayKey, { ymd, ts: nowIso, items: dayItems });

    // History & lock
    await kvSetBoth(historyKey, { ymd, ts: nowIso, items: ids, slot });
    await kvSetBoth(lockKey,    { ymd, ts: nowIso, last_slot: slot, count: ids.length });

    // Freshness markers for odds watcher & feed
    const marker = { ymd, ts: nowIso, last_odds_refresh: nowIso, items: ids.length };
    await kvSetBoth(vbLockedTodayKey, marker);
    await kvSetBoth(vbLockedMarker,   marker);

    return res.status(200).json({
      ok: true,
      ymd, slot,
      count: ids.length,
      wrote: { vblSlotKey, vblDayKey, historyKey, lockKey, vbLockedTodayKey, vbLockedMarker },
      sourceKey: unionKey,
      probes
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
