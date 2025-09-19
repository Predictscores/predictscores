// pages/api/history.js
import { computeROI } from "../../lib/history-utils";

export const config = { api: { bodyParser: false } };

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{ headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) { trace && trace.push({ get:key, ok:false, err:String(e?.message||e) }); }
  }
  return { raw:null, flavor:null };
}

/* ---------- helpers ---------- */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const isValidYmd = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||""));
const onlyMarketsCSV = (process.env.HISTORY_ALLOWED_MARKETS || "h2h").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
const allowSet = new Set(onlyMarketsCSV.length ? onlyMarketsCSV : ["h2h"]);
const BELGRADE_TZ = "Europe/Belgrade";
const belgradeDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BELGRADE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const belgradeMiddayAnchor = (date) => {
  const parts = { year: NaN, month: NaN, day: NaN };
  for (const part of belgradeDateFormatter.formatToParts(date)) {
    if (part.type === "year") parts.year = Number(part.value);
    else if (part.type === "month") parts.month = Number(part.value);
    else if (part.type === "day") parts.day = Number(part.value);
  }
  if (!Number.isFinite(parts.year) || !Number.isFinite(parts.month) || !Number.isFinite(parts.day)) {
    const fallback = new Date(date);
    fallback.setUTCHours(12, 0, 0, 0);
    return fallback;
  }
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
};
const arrFromAny = x => Array.isArray(x) ? x
  : (x && typeof x==="object" && Array.isArray(x.items)) ? x.items
  : (x && typeof x==="object" && Array.isArray(x.history)) ? x.history
  : (x && typeof x==="object" && Array.isArray(x.list)) ? x.list : [];
const dedupKey = e => `${e?.fixture_id||e?.id||"?"}__${String(e?.market_key||"").toLowerCase()}__${String(e?.pick||"").toLowerCase()}`;

/**
 * Filtriraj na dozvoljene markete (default: samo h2h), zadrži osnovna polja.
 */
function filterAllowed(arr) {
  const by = new Map();
  for (const e of (arr||[])) {
    const mkey = String(e?.market_key||"").toLowerCase();
    if (!allowSet.has(mkey)) continue;
    const k = dedupKey(e);
    if (!by.has(k)) by.set(k, e);
  }
  return Array.from(by.values());
}

async function loadHistoryForDay(ymd, trace) {
  // 1) Primarno: hist:<ymd>
  const histKey = `hist:${ymd}`;
  const { raw: rawHist } = await kvGETraw(histKey, trace);
  let items = filterAllowed(arrFromAny(J(rawHist)));
  let source = items.length ? histKey : null;

  // 2) Fallback: vb:day:<ymd>:combined (ali filtrirano na h2h)
  if (!items.length) {
    const combKey = `vb:day:${ymd}:combined`;
    const { raw: rawComb } = await kvGETraw(combKey, trace);
    items = filterAllowed(arrFromAny(J(rawComb)));
    source = items.length ? combKey : null;
  }

  // 3) Fallback chain: union -> last -> per-slot vbl_full (merge+dedupe)
  if (!items.length) {
    const unionKey = `vb:day:${ymd}:union`;
    const { raw: rawUnion } = await kvGETraw(unionKey, trace);
    const unionItems = filterAllowed(arrFromAny(J(rawUnion)));
    if (unionItems.length) {
      items = unionItems;
      source = unionKey;
    }
  }

  if (!items.length) {
    const lastKey = `vb:day:${ymd}:last`;
    const { raw: rawLast } = await kvGETraw(lastKey, trace);
    const lastItems = filterAllowed(arrFromAny(J(rawLast)));
    if (lastItems.length) {
      items = lastItems;
      source = lastKey;
    }
  }

  if (!items.length) {
    const slots = ["am", "pm", "late"];
    const slotMap = new Map();
    for (const slot of slots) {
      const key = `vbl_full:${ymd}:${slot}`;
      const { raw } = await kvGETraw(key, trace);
      const slotItems = arrFromAny(J(raw));
      if (!slotItems.length) continue;
      for (const entry of slotItems) {
        const dk = dedupKey(entry);
        if (!slotMap.has(dk)) slotMap.set(dk, { entry, key });
      }
    }
    const merged = filterAllowed(Array.from(slotMap.values()).map(v=>v.entry));
    if (merged.length) {
      items = merged;
      const srcSet = new Set();
      for (const it of merged) {
        const dk = dedupKey(it);
        const meta = slotMap.get(dk);
        if (meta?.key) srcSet.add(meta.key);
      }
      source = srcSet.size ? Array.from(srcSet).join(",") : null;
    }
  }

  return { items, source };
}

function lastNDaysList(n) {
  if (!Number.isFinite(n) || n <= 0) return [];
  const out = [];
  let cursor = belgradeMiddayAnchor(new Date());
  for (let i = 0; i < n; i++) {
    out.push(belgradeDateFormatter.format(cursor));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const qYmd = String(req.query.ymd||"").trim();
    const ymd = isValidYmd(qYmd) ? qYmd : null;

    let queriedDays = [];
    if (ymd) {
      queriedDays = [ymd];
    } else {
      const qDaysRaw = String(req.query.days||"").trim();
      const qDays = Number.parseInt(qDaysRaw, 10);
      if (!Number.isFinite(qDays) || qDays <= 0) {
        return res.status(200).json({ ok:false, error:"Provide ymd=YYYY-MM-DD or days=<N>" });
      }
      queriedDays = lastNDaysList(qDays);
    }

    const aggregated = [];
    const daySources = {};
    for (const day of queriedDays) {
      const { items: dayItems, source } = await loadHistoryForDay(day, trace);
      daySources[day] = source;
      aggregated.push(...dayItems);
      if (process.env.NODE_ENV !== "production") {
        console.info("[history]", { ymd: day, source, count: dayItems.length });
      }
    }

    const items = filterAllowed(aggregated);
    const roi = computeROI(items);
    const singleYmd = queriedDays.length === 1 ? queriedDays[0] : null;
    const source = singleYmd ? (daySources[singleYmd] || null) : null;

    return res.status(200).json({
      ok:true,
      ymd: singleYmd,
      queried_days: queriedDays,
      count: items.length,
      source,
      roi,
      history: items,
      debug:{ trace, allowed: Array.from(allowSet), day_sources: daySources }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
