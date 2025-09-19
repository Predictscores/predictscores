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
async function kvGETitems(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      const res = j && ("result" in j ? j.result : j);
      const obj = toJson(res);
      const items = arrFromAny(obj);
      if (!r.ok) continue;
      return { items, obj, flavor: b.flavor, kvResult: res };
    } catch {}
  }
  return { items: [], obj: null, flavor: null, kvResult: null };
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
  for (const e of arr || []) {
    const mkey = normalizeMarketKey(e?.market_key);
    if (!mkey || !allowSet.has(mkey)) continue;
    const k = dedupKey(e, mkey);
    if (!by.has(k)) by.set(k, e);
  }
  return Array.from(by.values());
}

async function loadDay(ymd) {
  const hist = await kvGETitems(`hist:${ymd}`);
  const histItems = filterAllowed(hist.items);

  const comb = await kvGETitems(`vb:day:${ymd}:combined`);
  const combItems = filterAllowed(comb.items);

  const useHist = histItems.length > 0;
  const chosenItems = useHist ? histItems : combItems;
  const chosen = useHist ? hist : comb;

  return {
    items: chosenItems,
    debugFlavor: chosen.flavor,
    debugResult: chosen.kvResult,
  };
}

export default async function handler(req, res) {
  try {
    const qYmd = String(req.query.ymd || "").trim();
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    const wantDebug = String(req.query?.debug || "") === "1";

    const ymdd = isValidYmd(qYmd)
      ? [qYmd]
      : Array.from({ length: days }, (_, i) => {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - i);
          return d.toISOString().slice(0, 10);
        });

    const aggregated = [];
    let debugFlavor = null;
    let debugResult;

    for (const ymd of ymdd) {
      const { items, debugFlavor: dayFlavor, debugResult: dayResult } = await loadDay(ymd);
      aggregated.push(...items);
      if (wantDebug) {
        if (!debugFlavor && dayFlavor) debugFlavor = dayFlavor;
        if (debugResult === undefined && dayResult !== undefined) debugResult = dayResult;
      }
    }

    const roi = computeROI(aggregated || []);
    const payload = {
      ok: true,
      days: ymdd.length,
      roi,
      count: aggregated.length,
    };

    if (wantDebug) {
      payload.debug = {
        sourceFlavor: debugFlavor || "unknown",
        kvObject: typeof debugResult === "object",
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
