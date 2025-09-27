// pages/api/value-bets-locked.js
// Returns today's frozen value-bets. Default: objects joined from snapshot.
// Query params:
//   ?ymd=YYYY-MM-DD
//   ?slot=am|pm|late
//   ?format=objects|ids   (default objects)
//   ?limit=number         (default 500; 0 = no cap)
//   ?fields=a,b,c         (for objects only)
// Works with KV_REST_* and/or UPSTASH_REDIS_REST_*.

export const config = { api: { bodyParser: false } };

/* ---------- date/slot ---------- */
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

/* ---------- dual KV ---------- */
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
    headers: { Authorization: `Bearer ${KV_TOK}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvGetUpstash(key) {
  if (!hasR) return null;
  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOK}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return typeof j?.result === "string" ? j.result : null;
}
async function kvGetAny(key) {
  const a = await kvGetREST(key);
  if (a != null) return a;
  return kvGetUpstash(key);
}

/* ---------- helpers ---------- */
function idsFromDoc(raw) {
  const doc = typeof raw === "string" ? (J(raw) ?? raw) : raw;
  if (!doc) return [];
  if (Array.isArray(doc)) return doc.filter(Boolean);
  if (typeof doc === "object" && Array.isArray(doc.items)) return doc.items.filter(Boolean);
  return [];
}
function pickFields(obj, whitelist) {
  if (!whitelist || !whitelist.size) return obj;
  const out = {};
  for (const k of whitelist) if (k in obj) out[k] = obj[k];
  return out;
}
function rowsFromChunk(raw) {
  const v = typeof raw === "string" ? (J(raw) ?? raw) : raw;
  if (!v) return [];
  if (Array.isArray(v)) return v;              // chunk is an array of rows
  if (Array.isArray(v.items)) return v.items;  // { items: [...] }
  return [];
}
function fxId(row) {
  if (!row) return null;
  return row.id ?? row.fixture_id ?? row.fixture?.id ?? null;
}

/* ---------- robust snapshot resolver ---------- */
async function loadSnapshotRows(ymd) {
  const idxKey = `vb:day:${ymd}:snapshot:index`;
  const legacyKey = `vb:day:${ymd}:snapshot`;
  const seen = new Set(); // guard self-reference

  const idxRaw = await kvGetAny(idxKey);
  const idx = typeof idxRaw === "string" ? (J(idxRaw) ?? idxRaw) : idxRaw;

  // Case A: index itself is a chunk object (has items)
  if (idx && typeof idx === "object" && Array.isArray(idx.items)) {
    return idx.items;
  }
  // Case B: index is a direct array of rows
  if (Array.isArray(idx) && idx.length && typeof idx[0] === "object") {
    return idx;
  }

  // Case C: index is a string key or an array of chunk keys
  let chunkKeys = [];
  if (typeof idx === "string") {
    if (idx === idxKey) {
      // self-referential; skip to legacy
    } else {
      chunkKeys = [idx];
    }
  } else if (idx && typeof idx === "object" && Array.isArray(idx.chunks)) {
    chunkKeys = idx.chunks.filter(Boolean);
  } else if (Array.isArray(idx) && idx.length && typeof idx[0] === "string") {
    chunkKeys = idx.filter(Boolean);
  }

  const rows = [];
  for (const ck of chunkKeys) {
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (ck === idxKey) continue; // avoid recursion
    const cRaw = await kvGetAny(ck);
    const arr = rowsFromChunk(cRaw);
    if (arr.length) rows.push(...arr);
  }
  if (rows.length) return rows;

  // Case D: fallback to legacy snapshot
  const legRaw = await kvGetAny(legacyKey);
  const legacy = typeof legRaw === "string" ? (J(legRaw) ?? legRaw) : legRaw;
  if (Array.isArray(legacy)) return legacy;
  if (legacy && typeof legacy === "object" && Array.isArray(legacy.items)) return legacy.items;

  return [];
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd  = String(req.query.ymd || belgradeYMD(now));
    const qSlot = String(req.query.slot || "").toLowerCase();
    const slot  = (qSlot === "am" || qSlot === "pm" || qSlot === "late") ? qSlot : inferSlotByTime(now);

    const format = String(req.query.format || "objects").toLowerCase(); // "objects" | "ids"
    let limit = Number(req.query.limit ?? 500);
    if (!Number.isFinite(limit) || limit < 0) limit = 500;
    const allow = String(req.query.fields || "").trim();
    const whitelist = allow ? new Set(allow.split(",").map(s => s.trim()).filter(Boolean)) : null;

    // load frozen ids (prefer slot, fallback day)
    const vblSlotKey = `vbl_full:${ymd}:${slot}`;
    const vblDayKey  = `vbl_full:${ymd}`;

    const [slotRaw, dayRaw] = await Promise.all([ kvGetAny(vblSlotKey), kvGetAny(vblDayKey) ]);
    let ids = idsFromDoc(slotRaw);
    if (!ids.length) ids = idsFromDoc(dayRaw);

    // Freshness
    const [ftRaw, fgRaw] = await Promise.all([
      kvGetAny(`vb-locked:kv:hit:${ymd}`),
      kvGetAny(`vb-locked:kv:hit`)
    ]);
    const ft = J(ftRaw) || {};
    const fg = J(fgRaw) || {};
    const ts = ft.ts || fg.ts || null;
    const last_odds_refresh = ft.last_odds_refresh || fg.last_odds_refresh || null;

    if (format === "ids") {
      const out = (limit && limit > 0) ? ids.slice(0, limit) : ids;
      return res.status(200).json({
        items: out,
        meta: { ymd, slot, source: "vb-locked:kv:hit", ts, last_odds_refresh, ids_total: ids.length, returned: out.length }
      });
    }

    // join to snapshot
    const rows = await loadSnapshotRows(ymd);
    const wanted = new Set(ids);
    const out = [];
    for (const row of rows) {
      const id = fxId(row);
      if (id == null) continue;
      if (!wanted.has(id)) continue;
      out.push(whitelist ? pickFields(row, whitelist) : row);
      if (limit && out.length >= limit) break;
    }

    return res.status(200).json({
      items: out,
      meta: { ymd, slot, source: "vb-locked:kv:hit", ts, last_odds_refresh, ids_total: ids.length, returned: out.length }
    });
  } catch (e) {
    return res.status(200).json({
      items: [],
      meta: { ymd: String(req.query.ymd || belgradeYMD()), slot: String(req.query.slot || ""), source: "vb-locked:kv:hit", ts: null, last_odds_refresh: null },
      error: String(e?.message || e),
    });
  }
}
