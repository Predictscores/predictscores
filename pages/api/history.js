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
      const hadValue = typeof res === "string" ? res.length > 0 : res != null;
      return { items, obj, flavor: b.flavor, kvResult: res, hadValue };
    } catch {}
  }
  return { items: [], obj: null, flavor: null, kvResult: null, hadValue: false };
}

/* ---------- helpers ---------- */
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const DEFAULT_MARKET_KEY = "h2h";
const MARKET_KEY_SYNONYMS = {
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

// Robust market parser (ignores stray punctuation; defaults to "h2h")
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

const dedupKey = (e, normalizedMarketKey) => {
  const m = normalizedMarketKey ?? normalizeMarketKey(e?.market_key);
  const pick = String(e?.pick || "").toLowerCase().trim();
  return `${e?.fixture_id || e?.id || "?"}__${m}__${pick}`;
};

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

async function loadHistoryForDay(ymd) {
  const histKey = `hist:${ymd}`;
  const hist = await kvGETitems(histKey);
  const histItems = filterAllowed(hist.items);

  const combKey = `vb:day:${ymd}:combined`;
  const comb = await kvGETitems(combKey);
  const combItems = filterAllowed(comb.items);

  const useHist = histItems.length > 0;
  const items = useHist ? histItems : combItems;
  const chosen = useHist ? hist : comb;

  return {
    items,
    sources: { hist: hist.hadValue, combined: comb.hadValue },
    debugFlavor: chosen.flavor,
    debugResult: chosen.kvResult,
  };
}

function computeRoi(items) {
  try {
    return computeROI(items);
  } catch {
    return null;
  }
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
    let debugFlavor = null;
    let debugResult;

    for (const day of queriedDays) {
      const { items, sources, debugFlavor: dayFlavor, debugResult: dayResult } = await loadHistoryForDay(day);
      daySources[day] = sources;
      aggregated.push(...items);
      if (wantDebug) {
        if (!debugFlavor && dayFlavor) debugFlavor = dayFlavor;
        if (debugResult === undefined && dayResult !== undefined) debugResult = dayResult;
      }
    }

    const items = filterAllowed(aggregated);
    const roi = computeRoi(items);

    const singleYmd = ymd || (queriedDays.length ? queriedDays[0] : null);
    const payload = {
      ok: true,
      ymd: singleYmd,
      queried_days: queriedDays,
      count: items.length,
      source: daySources,
      roi,
      history: items,
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
