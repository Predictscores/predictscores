// lib/server/history-loader.js
import { computeROI } from "../history-utils";

/* ---------- KV helpers shared between API and SSR ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL;
  const aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL;
  const bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/g, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/g, ""), tok: bT });
  return out;
}

async function kvGETraw(key, trace) {
  for (const backend of kvBackends()) {
    try {
      const r = await fetch(`${backend.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${backend.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const raw = typeof j?.result === "string" ? j.result : null;
      if (trace) {
        trace.push({ get: key, ok: r.ok, flavor: backend.flavor, hit: !!raw });
      }
      if (!r.ok) continue;
      if (raw != null) {
        return { raw, flavor: backend.flavor };
      }
    } catch (e) {
      if (trace) {
        trace.push({ get: key, ok: false, err: String(e?.message || e) });
      }
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- shared helpers ---------- */
export const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const onlyMarketsCSV = (process.env.HISTORY_ALLOWED_MARKETS || "h2h")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const allowSet = new Set(onlyMarketsCSV.length ? onlyMarketsCSV : ["h2h"]);

const J = (s) => {
  try {
    return JSON.parse(String(s || ""));
  } catch {
    return null;
  }
};

const arrFromAny = (x) =>
  Array.isArray(x)
    ? x
    : x && typeof x === "object" && Array.isArray(x.items)
    ? x.items
    : x && typeof x === "object" && Array.isArray(x.history)
    ? x.history
    : x && typeof x === "object" && Array.isArray(x.list)
    ? x.list
    : [];

const dedupKey = (e) =>
  `${e?.fixture_id || e?.id || "?"}__${String(e?.market_key || "").toLowerCase()}__${String(e?.pick || "").toLowerCase()}`;

function filterAllowed(arr) {
  const by = new Map();
  for (const entry of arr || []) {
    const mkey = String(entry?.market_key || "").toLowerCase();
    if (!allowSet.has(mkey)) continue;
    const key = dedupKey(entry);
    if (!by.has(key)) by.set(key, entry);
  }
  return Array.from(by.values());
}

async function loadHistoryForDay(ymd, trace) {
  const histKey = `hist:${ymd}`;
  const { raw: rawHist } = await kvGETraw(histKey, trace);
  let items = filterAllowed(arrFromAny(J(rawHist)));
  let source = items.length ? histKey : null;

  if (!items.length) {
    const combKey = `vb:day:${ymd}:combined`;
    const { raw: rawComb } = await kvGETraw(combKey, trace);
    items = filterAllowed(arrFromAny(J(rawComb)));
    source = items.length ? combKey : null;
  }

  return { items, source };
}

function lastNDaysList(n) {
  const out = [];
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < n; i += 1) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function fetchHistoryAggregation({ days, ymd, includeDebug = false }) {
  const trace = includeDebug ? [] : null;

  const trimmedYmd = isValidYmd(ymd) ? ymd : null;
  let queriedDays = [];
  if (trimmedYmd) {
    queriedDays = [trimmedYmd];
  } else {
    const n = Number.parseInt(days, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("Provide ymd=YYYY-MM-DD or days>0");
    }
    queriedDays = lastNDaysList(n);
  }

  const aggregated = [];
  const daySources = {};
  for (const day of queriedDays) {
    const { items: dayItems, source } = await loadHistoryForDay(day, trace);
    daySources[day] = source;
    aggregated.push(...dayItems);
  }

  const items = filterAllowed(aggregated);
  const roi = computeROI(items);
  const singleYmd = queriedDays.length === 1 ? queriedDays[0] : null;
  const source = singleYmd ? daySources[singleYmd] || null : null;

  const payload = {
    ok: true,
    ymd: singleYmd,
    queried_days: queriedDays,
    count: items.length,
    source,
    roi,
    history: items,
  };

  if (includeDebug) {
    payload.debug = {
      trace,
      allowed: Array.from(allowSet),
      day_sources: daySources,
    };
  }

  return payload;
}

export function historyAllowList() {
  return Array.from(allowSet);
}
