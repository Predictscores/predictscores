// pages/api/value-bets-locked.js
// Returns today's frozen value-bets. By default it JOINs IDs to snapshot and returns objects.
// Query params:
//   ymd=YYYY-MM-DD
//   slot=am|pm|late   (optional; auto-inferred by Belgrade time if omitted)
//   format=objects|ids  (default: objects)
//   limit=number        (default: 500; 0 = no cap)
//   fields=a,b,c        (whitelist fields when format=objects)
// Works with KV_REST_* (Vercel KV) and/or UPSTASH_REDIS_REST_*.

export const config = { api: { bodyParser: false } };

/* ---------- date/slot helpers ---------- */
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
async function kvGetUpstash(key) {
  if (!hasR) return null;
  const r = await fetch(`${R_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${R_TOK}` }, cache: "no-store",
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

/* ---------- normalize helpers ---------- */
function idsFromDoc(raw) {
  const doc = typeof raw === "string" ? (J(raw) ?? raw) : raw;
  if (!doc) return [];
  if (Array.isArray(doc)) return doc.filter(Boolean);
  if (typeof doc === "object" && Array.isArray(doc.items)) return doc.items.filter(Boolean);
  return [];
}
function pickFields(obj, allow) {
  if (!allow || !allow.size) return obj;
  const out = {};
  for (const k of allow) if (k in obj) out[k] = obj[k];
  return out;
}

/* ---------- snapshot join ---------- */
// Snapshot index can be:
//  - { chunks: ["vb:day:<ymd>:snapshot:0", ...] }
//  - ["vb:day:<ymd>:snapshot:0", ...]
//  - or (rarely) a single chunk key string
function parseChunkKeys(idxRaw) {
  const idx = typeof idxRaw === "string" ? (J(idxRaw) ?? idxRaw) : idxRaw;
  if (!idx) return [];
  if (typeof idx === "string") return [idx];
  if (Array.isArray(idx)) return idx.filter(Boolean);
  if (Array.isArray(idx.chunks)) return idx.chunks.filter(Boolean);
  return [];
}

// A chunk can be:
//  - { items: [ { id / fixture.id / fixture_id, ... }, ... ] }
//  - [ { ... }, ... ]
function rowsFromChunk(raw) {
  const v = typeof raw === "string" ? (J(raw) ?? raw) : raw;
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.items)) return v.items;
  return [];
}
function fxId(row) {
  if (!row) return null;
  return row.id ?? row.fixture_id ?? row.fixture?.id ?? null;
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd  = String(req.query.ymd || belgradeYMD(now));
    const qSlot = String(req.query.slot || "").toLowerCase();
    const slot  = (qSlot === "am" || qSlot === "pm" || qSlot === "late") ? qSlot : inferSlotByTime(now);

    const format = (String(req.query.format || "objects")).toLowerCase(); // "objects" | "ids"
    let limit = Number(req.query.limit ?? 500);
    if (!Number.isFinite(limit) || limit < 0) limit = 500;
    const allow = String(req.query.fields || "").trim();
    const whitelist = allow ? new Set(allow.split(",").map(s => s.trim()).filter(Boolean)) : null;

    // Keys written by apply-learning
    const vblSlotKey      = `vbl_full:${ymd}:${slot}`;
    const vblDayKey       = `vbl_full:${ymd}`;
    const freshnessToday  = `vb-locked:kv:hit:${ymd}`;
    const freshnessGlobal = `vb-locked:kv:hit`;

    // Load frozen items (prefer slot, fall back to day)
    const [slotRaw, dayRaw] = await Promise.all([ kvGetAny(vblSlotKey), kvGetAny(vblDayKey) ]);
    let ids = idsFromDoc(slotRaw);
    if (!ids.length) ids = idsFromDoc(dayRaw);

    // If IDs requested, short-circuit
    if (format === "ids") {
      const [ftRaw, fgRaw] = await Promise.all([ kvGetAny(freshnessToday), kvGetAny(freshnessGlobal) ]);
      const ft = J(ftRaw) || {};
      const fg = J(fgRaw) || {};
      const ts = ft.ts || fg.ts || null;
      const last_odds_refresh = ft.last_odds_refresh || fg.last_odds_refresh || null;
      const out = (limit && limit > 0) ? ids.slice(0, limit) : ids;
      return res.status(200).json({
        items: out,
        meta: { ymd, slot, source: "vb-locked:kv:hit", ts, last_odds_refresh }
      });
    }

    // Otherwise, join IDs to snapshot rows
    const snapshotIndexKey = `vb:day:${ymd}:snapshot:index`;
    const idxRaw = await kvGetAny(snapshotIndexKey);
    const chunkKeys = parseChunkKeys(idxRaw);

    // Load chunks sequentially but cheaply; stop when we collected enough
    const wanted = new Set(ids);
    const rows = [];
    for (const ck of chunkKeys) {
      if (limit && rows.length >= limit) break;
      const cRaw = await kvGetAny(ck);
      const arr = rowsFromChunk(cRaw);
      for (const row of arr) {
        const id = fxId(row);
        if (id == null) continue;
        if (!wanted.has(id)) continue;
        rows.push(whitelist ? pickFields(row, whitelist) : row);
        if (limit && rows.length >= limit) break;
      }
    }

    // Freshness/meta
    const [ftRaw, fgRaw] = await Promise.all([ kvGetAny(freshnessToday), kvGetAny(freshnessGlobal) ]);
    const ft = J(ftRaw) || {};
    const fg = J(fgRaw) || {};
    const ts = ft.ts || fg.ts || null;
    const last_odds_refresh = ft.last_odds_refresh || fg.last_odds_refresh || null;

    return res.status(200).json({
      items: rows,
      meta: {
        ymd,
        slot,
        source: "vb-locked:kv:hit",
        ts,
        last_odds_refresh,
        ids_total: ids.length,
        returned: rows.length,
      },
    });
  } catch (e) {
    return res.status(200).json({
      items: [],
      meta: { ymd: String(req.query.ymd || belgradeYMD()), slot: String(req.query.slot || ""), source: "vb-locked:kv:hit", ts: null, last_odds_refresh: null },
      error: String(e?.message || e),
    });
  }
}
