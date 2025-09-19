// File: pages/api/history.js
import { computeROI } from "../../lib/history-utils";

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
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get: key, ok: r.ok, flavor: b.flavor, hit: !!raw });
      if (!r.ok) continue;
      return { raw, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ get: key, ok: false, err: String(e?.message || e) });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- helpers ---------- */
const J = (s) => {
  try { return JSON.parse(String(s || "")); } catch { return null; }
};
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

// Robust market parser (ignores stray punctuation; defaults to "h2h")
function parseAllowedMarkets(envVal) {
  const raw = String(envVal ?? "h2h");
  const list = raw.split(",")
    .map(s => s.toLowerCase().replace(/[^a-z0-9_:-]/g, "").trim())
    .filter(Boolean);
  return new Set(list.length ? list : ["h2h"]);
}
const allowSet = parseAllowedMarkets(process.env.HISTORY_ALLOWED_MARKETS);

const arrFromAny = (x) =>
  Array.isArray(x) ? x
  : (x && typeof x === "object" && Array.isArray(x.items)) ? x.items
  : (x && typeof x === "object" && Array.isArray(x.history)) ? x.history
  : (x && typeof x === "object" && Array.isArray(x.list)) ? x.list
  : [];

const dedupKey = (e) =>
  `${e?.fixture_id || e?.id || "?"}__${String(e?.market_key || "").toLowerCase()}__${String(e?.pick || "").toLowerCase()}`;

function filterAllowed(arr) {
  const by = new Map();
  for (const e of (arr || [])) {
    const mkey = String(e?.market_key || "").toLowerCase();
    if (!allowSet.has(mkey)) continue;
    const k = dedupKey(e);
    if (!by.has(k)) by.set(k, e);
  }
  return Array.from(by.values());
}

async function loadHistoryForDay(ymd, trace) {
  const histKey = `hist:${ymd}`;
  const { raw: rawHist } = await kvGETraw(histKey, trace);

  let items = filterAllowed(arrFromAny(J(rawHist)));

  // Fallback: combined list
  const combKey = `vb:day:${ymd}:combined`;
  const { raw: rawComb } = await kvGETraw(combKey, trace);
  if (!items.length && rawComb) {
    items = filterAllowed(arrFromAny(J(rawComb)));
  }

  return { items, sources: { hist: !!rawHist, combined: !!rawComb } };
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

    let queriedDays = [];
    if (ymd) {
      queriedDays = [ymd];
    } else {
      const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
      queriedDays = recentDays(new Date(), days);
    }

    const aggregated = [];
    const daySources = {};
    for (const day of queriedDays) {
      const { items, sources } = await loadHistoryForDay(day, trace);
      daySources[day] = sources;
      aggregated.push(...items);
    }

    const items = filterAllowed(aggregated);
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
      debug: { trace, allowed: Array.from(allowSet), day_sources: daySources },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
