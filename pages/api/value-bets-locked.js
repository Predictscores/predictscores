// pages/api/value-bets-locked.js
// Returns today's frozen value-bets from vbl_* keys and attaches freshness metadata.
// Reads from BOTH possible KV backends (KV_REST_* and/or UPSTASH_REDIS_REST_*).

export const config = { api: { bodyParser: false } };

/* ---------- slot & date helpers ---------- */
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

/* ---------- normalize ---------- */
function idsFromDoc(raw) {
  const doc = typeof raw === "string" ? (J(raw) ?? raw) : raw;
  if (!doc) return [];
  if (Array.isArray(doc)) return doc.filter(Boolean);
  if (typeof doc === "object") {
    if (Array.isArray(doc.items)) return doc.items.filter(Boolean);
  }
  return [];
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd  = String(req.query.ymd || belgradeYMD(now));
    const qSlot = String(req.query.slot || "").toLowerCase();
    const slot  = (qSlot === "am" || qSlot === "pm" || qSlot === "late") ? qSlot : inferSlotByTime(now);

    // Keys written by apply-learning
    const vblSlotKey       = `vbl_full:${ymd}:${slot}`;
    const vblDayKey        = `vbl_full:${ymd}`;
    const freshnessToday   = `vb-locked:kv:hit:${ymd}`;
    const freshnessGlobal  = `vb-locked:kv:hit`;

    // Load frozen items
    const [slotRaw, dayRaw, fTodayRaw, fGlobalRaw] = await Promise.all([
      kvGetAny(vblSlotKey),
      kvGetAny(vblDayKey),
      kvGetAny(freshnessToday),
      kvGetAny(freshnessGlobal),
    ]);

    let items = idsFromDoc(slotRaw);
    if (!items.length) items = idsFromDoc(dayRaw);

    // Freshness/meta
    const ft = J(fTodayRaw) || {};
    const fg = J(fGlobalRaw) || {};
    const ts = ft.ts || fg.ts || null;
    const last_odds_refresh = ft.last_odds_refresh || fg.last_odds_refresh || null;

    return res.status(200).json({
      items,
      meta: {
        ymd,
        slot,
        source: "vb-locked:kv:hit",
        ts,
        last_odds_refresh,
      },
    });
  } catch (e) {
    return res.status(200).json({
      items: [],
      meta: { ymd: String(req.query.ymd || belgradeYMD()), source: "vb-locked:kv:hit", ts: null, last_odds_refresh: null },
      error: String(e?.message || e),
    });
  }
}
