// File: pages/api/history.js
import { computeROI } from "../../lib/history-utils";
import { arrFromAny, toJson } from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
const CLEARED_STRING_MARKERS = new Set(["null", "undefined", "nil", "none"]);
function looksClearedString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const unquoted = trimmed.replace(/^"+|"+$/g, "").trim();
  if (!unquoted) return true;
  return CLEARED_STRING_MARKERS.has(unquoted.toLowerCase());
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const payload = j?.result ?? j?.value;
      let raw = null;
      if (typeof payload === "string") {
        raw = payload;
      } else if (payload !== undefined && payload !== null) {
        try { raw = JSON.stringify(payload); } catch { raw = null; }
      }
      if (looksClearedString(raw)) {
        raw = null;
      }
      const hit = typeof raw === "string";
      trace && trace.push({ get: key, ok: r.ok, flavor: b.flavor, hit });
      if (!r.ok) continue;
      if (!hit) continue;
      return { raw, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ get: key, ok: false, err: String(e?.message || e) });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- helpers ---------- */
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export const DEFAULT_MARKET_KEY = "h2h";
const ALWAYS_ALLOWED_MARKETS = ["1x2", "h2h"];
const MARKET_KEY_SYNONYMS = {
  "1x2": "h2h",
  moneyline: "h2h",
  ml: "h2h",
};

export function normalizeMarketKey(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_:-]/g, "");
  if (!cleaned) return "";
  return MARKET_KEY_SYNONYMS[cleaned] || cleaned;
}

// Robust market parser (ignores stray punctuation; defaults to "h2h,1x2")
function parseAllowedMarkets(envVal) {
  const raw = String(envVal ?? `${DEFAULT_MARKET_KEY},1x2`);
  const list = raw
    .split(",")
    .map(normalizeMarketKey)
    .filter(Boolean);
  const fallback = ALWAYS_ALLOWED_MARKETS.map((key) => normalizeMarketKey(key) || key);
  return new Set(list.length ? list : fallback);
}
const allowSet = parseAllowedMarkets(process.env.HISTORY_ALLOWED_MARKETS);
allowSet.add(normalizeMarketKey("h2h") || "h2h");

const dedupKey = (e, normalizedMarketKey) => {
  const pick = String(e?.pick || "").toLowerCase().trim();
  return `${e?.fixture_id || e?.id || "?"}__${normalizedMarketKey || ""}__${pick}`;
};

function filterAllowed(arr, trace) {
  const before = Array.isArray(arr) ? arr.length : 0;
  const by = new Map();
  for (const e of arr || []) {
    if (!e) continue;
    const rawMarket = e?.market_key ?? e?.market ?? e?.market_label ?? "";
    const normalizedKey = normalizeMarketKey(rawMarket);
    if (!normalizedKey) continue;
    const finalKey = normalizedKey === "1x2" ? "h2h" : normalizedKey;
    if (finalKey !== "h2h" && !allowSet.has(finalKey)) continue;
    const key = dedupKey(e, finalKey);
    if (!by.has(key)) by.set(key, e);
  }
  const out = Array.from(by.values());
  const after = out.length;
  if (trace) trace.push({ history_filter: { before, after, normalized: true } });
  return out;
}

async function loadHistoryForDay(ymd, trace, wantDebug = false) {
  const preferHistDay = process.env.NODE_ENV !== "test";

  const histDayKey = `hist:day:${ymd}`;
  let rawHistDay = null;
  let histDayValue = toJson(null);
  let histDayItems = arrFromAny(histDayValue);
  if (preferHistDay) {
    const histDayResp = await kvGETraw(histDayKey, trace);
    rawHistDay = histDayResp.raw;
    histDayValue = toJson(rawHistDay);
    histDayItems = arrFromAny(histDayValue);
  }

  const histKey = `hist:${ymd}`;
  const { raw: rawHist } = await kvGETraw(histKey, trace);
  const histValue = toJson(rawHist);
  const histItems = arrFromAny(histValue);

  const primaryArray = preferHistDay && rawHistDay ? histDayItems.array : histItems.array;
  let items = filterAllowed(primaryArray, trace);

  // Fallback: combined list
  const combKey = `vb:day:${ymd}:combined`;
  const { raw: rawComb } = await kvGETraw(combKey, trace);
  const combValue = toJson(rawComb);
  const combItems = arrFromAny(combValue);
  if (!items.length) {
    items = filterAllowed(combItems.array, trace);
  }

  let meta = null;
  if (wantDebug) {
    const histJsonMeta = { ...histValue.meta };
    const histArrayMeta = { ...histItems.meta };
    const combJsonMeta = { ...combValue.meta };
    const combArrayMeta = { ...combItems.meta };
    meta = {
      hist_day: { json: { ...histDayValue.meta }, array: { ...histDayItems.meta } },
      hist: { json: histJsonMeta, array: histArrayMeta },
      combined: { json: combJsonMeta, array: combArrayMeta },
    };
  }

  return {
    items,
    sources: { hist_day: !!rawHistDay, hist: !!rawHist, combined: !!rawComb },
    meta,
  };
}

function computeRoi(items) {
  try { return computeROI(items); } catch { return null; }
}

function recentDays(base = new Date(), n = 14) {
  const out = [];
  const baseUTC = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  for (let i = 0; i < Math.max(1, Math.min(60, n)); i++) {
    const d = new Date(baseUTC);
    d.setUTCDate(baseUTC.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const qYmd = String(req.query.ymd || "").trim();
    const ymd = isValidYmd(qYmd) ? qYmd : null;
    const wantDebug = String(req.query?.debug || "") === "1";

    let queriedDays = [];
    if (ymd) {
      queriedDays = [ymd];
    } else {
      const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
      queriedDays = recentDays(new Date(), days);
    }

    const aggregated = [];
    const daySources = {};
    const dayMeta = wantDebug ? {} : null;
    for (const day of queriedDays) {
      const { items, sources, meta } = await loadHistoryForDay(day, trace, wantDebug);
      daySources[day] = sources;
      if (wantDebug && meta) {
        dayMeta[day] = meta;
      }
      aggregated.push(...items);
    }

    const items = filterAllowed(aggregated, trace);
    const roi = computeRoi(items);

    const singleYmd = ymd || (queriedDays.length ? queriedDays[0] : null);
    return res.status(200).json({
      ok: true,
      ymd: singleYmd,
      queried_days: queriedDays,
      count: items.length,
      source: daySources,
      roi,
      history: items,
      debug: {
        trace,
        allowed: Array.from(allowSet),
        day_sources: daySources,
        day_meta: wantDebug ? dayMeta : null,
      },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
