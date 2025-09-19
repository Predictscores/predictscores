// File: pages/api/history-roi.js
import { computeROI } from "../../lib/history-utils";
import { normalizeMarketKey } from "./history";
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
      } else if (payload !== undefined) {
        try { raw = JSON.stringify(payload ?? null); } catch { raw = null; }
      }
      trace && trace.push({ get: key, ok: r.ok, flavor: b.flavor, hit: typeof raw === "string" });
      if (!r.ok) continue;
      return { raw, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ get: key, ok: false, err: String(e?.message || e) });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- helpers ---------- */
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const DEFAULT_MARKET_KEY = "h2h";

function parseAllowedMarkets(envVal) {
  const raw = String(envVal ?? DEFAULT_MARKET_KEY);
  const list = raw
    .split(",")
    .map(normalizeMarketKey)
    .filter(Boolean);
  const fallback = normalizeMarketKey(DEFAULT_MARKET_KEY) || DEFAULT_MARKET_KEY;
  return new Set(list.length ? list : [fallback]);
}
const allowSet = parseAllowedMarkets(process.env.HISTORY_ALLOWED_MARKETS);

function dedupKey(e, normalizedMarketKey) {
  const m = normalizedMarketKey ?? normalizeMarketKey(e?.market_key);
  const pick = String(e?.pick || "").toLowerCase().trim();
  return `${e?.fixture_id || e?.id || "?"}__${m}__${pick}`;
}

function filterAllowed(arr) {
  const by = new Map();
  for (const e of (arr || [])) {
    const mkey = normalizeMarketKey(e?.market_key);
    if (!mkey || !allowSet.has(mkey)) continue;
    const k = dedupKey(e, mkey);
    if (!by.has(k)) by.set(k, e);
  }
  return Array.from(by.values());
}

async function loadDay(ymd, trace) {
  const histKey = `hist:${ymd}`;
  const { raw: rawHist } = await kvGETraw(histKey, trace);

  const histJson = toJson(rawHist);
  const histArr = arrFromAny(histJson.value, histJson.meta);
  let items = filterAllowed(histArr.array);

  const combKey = `vb:day:${ymd}:combined`;
  const { raw: rawComb } = await kvGETraw(combKey, trace);
  const combJson = toJson(rawComb);
  const combArr = arrFromAny(combJson.value, combJson.meta);
  if (!items.length) {
    items = filterAllowed(combArr.array);
  }
  return {
    items,
    meta: {
      hist: { json: histJson.meta, array: histArr.meta },
      combined: { json: combJson.meta, array: combArr.meta },
    },
  };
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const qYmd = String(req.query.ymd || "").trim();
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));

    const ymdd = isValidYmd(qYmd)
      ? [qYmd]
      : Array.from({ length: days }, (_, i) => {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - i);
          return d.toISOString().slice(0, 10);
        });

    const aggregated = [];
    const readMeta = {};
    for (const ymd of ymdd) {
      const { items, meta } = await loadDay(ymd, trace);
      aggregated.push(...items);
      readMeta[ymd] = meta;
    }

    const roi = computeROI(aggregated || []);
    return res.status(200).json({
      ok: true,
      days: ymdd.length,
      roi,
      count: aggregated.length,
      debug: { trace, allowed: Array.from(allowSet), reads: readMeta },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
