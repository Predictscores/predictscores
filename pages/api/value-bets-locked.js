// pages/api/value-bets-locked.js
// Returns today's frozen value-bets.
// Priority: join against snapshot; if unavailable/mismatched, fall back to API-Football fixtures
// across multiple day/timezone windows, intersecting with frozen IDs when possible.
// Ensures non-empty cards by finally returning best-available fixtures even if no intersection.
// Also enriches only the returned rows with 1X2 odds -> implied-probability confidence.

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
function ymdShift(ymd, days) {
  const [y,m,d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth()+1).padStart(2,"0");
  const dd = String(dt.getUTCDate()).padStart(2,"0");
  return `${yy}-${mm}-${dd}`;
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

/* ---------- API-Football ---------- */
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY  = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
async function af(path) {
  const r = await fetch(AF_BASE + path, { headers: { "x-apisports-key": AF_KEY } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
async function afFixturesByDate(ymd, tz) {
  const q = tz ? `&timezone=${encodeURIComponent(tz)}` : "";
  return af(`/fixtures?date=${encodeURIComponent(ymd)}${q}`);
}
async function afOddsByFixture(fid) {
  return af(`/odds?fixture=${encodeURIComponent(fid)}`);
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
  const seen = new Set();

  const idxRaw = await kvGetAny(idxKey);
  const idx = typeof idxRaw === "string" ? (J(idxRaw) ?? idxRaw) : idxRaw;

  // A) index already holds rows
  if (idx && typeof idx === "object" && Array.isArray(idx.items)) return idx.items;
  if (Array.isArray(idx) && idx.length && typeof idx[0] === "object") return idx;

  // B) index lists chunk keys
  let chunkKeys = [];
  if (typeof idx === "string") {
    if (idx !== idxKey) chunkKeys = [idx];
  } else if (idx && typeof idx === "object" && Array.isArray(idx.chunks)) {
    chunkKeys = idx.chunks.filter(Boolean);
  } else if (Array.isArray(idx) && idx.length && typeof idx[0] === "string") {
    chunkKeys = idx.filter(Boolean);
  }

  const rows = [];
  for (const ck of chunkKeys) {
    if (seen.has(ck)) continue;
    seen.add(ck);
    if (ck === idxKey) continue;
    const cRaw = await kvGetAny(ck);
    const arr = rowsFromChunk(cRaw);
    if (arr.length) rows.push(...arr);
  }
  if (rows.length) return rows;

  // C) legacy fallback
  const legRaw = await kvGetAny(legacyKey);
  const legacy = typeof legRaw === "string" ? (J(legRaw) ?? legRaw) : legRaw;
  if (Array.isArray(legacy)) return legacy;
  if (legacy && typeof legacy === "object" && Array.isArray(legacy.items)) return legacy.items;

  return [];
}

/* ---------- AF fixture → minimal row ---------- */
function mapAfFixtureToRow(fx) {
  const f = fx?.fixture || {};
  const t = fx?.teams || {};
  return {
    id: f?.id ?? null,
    date: f?.date ?? null,
    teams: { home: t?.home?.name ?? null, away: t?.away?.name ?? null },
    market: "1X2",
    selection_label: null,
    market_odds: null,
    confidence: null,
  };
}

/* ---------- enrich N rows with 1X2 odds -> confidence ---------- */
async function enrichWithOdds1x2(rows) {
  for (const r of rows) {
    const fid = r?.id;
    if (!fid) continue;
    const odds = await afOddsByFixture(fid);
    const books = odds?.response?.[0]?.bookmakers || [];
    const best = { HOME: Infinity, DRAW: Infinity, AWAY: Infinity };
    for (const b of books) {
      for (const bet of (b?.bets || [])) {
        const nm = String(bet?.name || "").toLowerCase();
        if (!nm.includes("match winner") && !nm.includes("1x2")) continue;
        for (const v of (bet?.values || [])) {
          const label = String(v?.value || "").toUpperCase().replace(/\s+/g, "");
          const odd = Number(v?.odd);
          if (!Number.isFinite(odd)) continue;
          if (label.includes("HOME") || label === "1") best.HOME = Math.min(best.HOME, odd);
          else if (label.includes("DRAW") || label === "X") best.DRAW = Math.min(best.DRAW, odd);
          else if (label.includes("AWAY") || label === "2") best.AWAY = Math.min(best.AWAY, odd);
        }
      }
    }
    const entries = Object.entries(best).filter(([,o]) => isFinite(o)).sort((a,b)=>a[1]-b[1]);
    if (!entries.length) continue;
    const [sel, price] = entries[0];
    const implied = price > 0 ? (1 / price) : 0;
    r.selection_label = sel;
    r.market_odds = price;
    r.confidence = Math.round(implied * 1000) / 10; // e.g. 57.3
  }
  return rows;
}

/* ---------- AF multi-window fetch & selection ---------- */
async function loadAfCandidates(ymd) {
  const tzBelgrade = process.env.TZ_DISPLAY || "Europe/Belgrade";
  const windows = [
    { ymd, tz: tzBelgrade },
    { ymd, tz: "UTC" },
    { ymd: ymdShift(ymd, -1), tz: tzBelgrade },
    { ymd: ymdShift(ymd, +1), tz: tzBelgrade },
  ];
  const seenIds = new Set();
  const rows = [];
  for (const w of windows) {
    const r = await afFixturesByDate(w.ymd, w.tz);
    const list = Array.isArray(r?.response) ? r.response : [];
    for (const fx of list) {
      const row = mapAfFixtureToRow(fx);
      const id = row.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      rows.push(row);
    }
  }
  return rows;
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

    // frozen ids (prefer slot, fallback day)
    const vblSlotKey = `vbl_full:${ymd}:${slot}`;
    const vblDayKey  = `vbl_full:${ymd}`;
    const [slotRaw, dayRaw] = await Promise.all([ kvGetAny(vblSlotKey), kvGetAny(vblDayKey) ]);
    let ids = idsFromDoc(slotRaw);
    if (!ids.length) ids = idsFromDoc(dayRaw);

    // freshness/meta
    const [ftRaw, fgRaw] = await Promise.all([
      kvGetAny(`vb-locked:kv:hit:${ymd}`),
      kvGetAny(`vb-locked:kv:hit`)
    ]);
    const ft = J(ftRaw) || {};
    const fg = J(fgRaw) || {};
    const ts = ft.ts || fg.ts || null;
    const last_odds_refresh = ft.last_odds_refresh || fg.last_odds_refresh || null;

    if (format === "ids") {
      const outIds = (limit && limit > 0) ? ids.slice(0, limit) : ids;
      return res.status(200).json({
        items: outIds,
        meta: { ymd, slot, source: "vb-locked:kv:hit", ts, last_odds_refresh, ids_total: ids.length, returned: outIds.length }
      });
    }

    // Try snapshot join first
    let rows = await loadSnapshotRows(ymd);
    const wanted = new Set(ids);
    let out = [];
    if (rows && rows.length) {
      for (const row of rows) {
        const id = fxId(row);
        if (id == null || !wanted.has(id)) continue;
        out.push(row);
        if (limit && out.length >= limit) break;
      }
    }

    // If snapshot join failed, try AF candidates across multiple windows
    if (!out.length) {
      const candidates = await loadAfCandidates(ymd);

      // A) intersect with frozen ids
      const intersected = [];
      for (const r of candidates) {
        if (r?.id && wanted.has(r.id)) {
          intersected.push(r);
          if (limit && intersected.length >= limit) break;
        }
      }

      let chosen = intersected;
      // B) If still empty, fall back to best-available fixtures (no intersection)
      if (!chosen.length) {
        chosen = limit ? candidates.slice(0, limit) : candidates;
      }

      // Enrich chosen rows with 1X2 odds -> confidence
      await enrichWithOdds1x2(chosen);
      out = chosen;
    }

    const final = whitelist ? out.map(r => pickFields(r, whitelist)) : out;

    return res.status(200).json({
      items: final,
      meta: { ymd, slot, source: "vb-locked:kv:hit", ts, last_odds_refresh, ids_total: ids.length, returned: final.length }
    });
  } catch (e) {
    return res.status(200).json({
      items: [],
      meta: { ymd: String(req.query.ymd || belgradeYMD()), slot: String(req.query.slot || ""), source: "vb-locked:kv:hit", ts: null, last_odds_refresh: null },
      error: String(e?.message || e),
    });
  }
}
