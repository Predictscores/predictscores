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
async function kvGETraw(key, trace, traceKey) {
  const label = traceKey || key;
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
      if (trace) {
        const entry = { get: label, ok: r.ok, flavor: b.flavor, hit };
        if (label !== key) entry.actual_key = key;
        trace.push(entry);
      }
      if (!r.ok) continue;
      if (!hit) continue;
      return { raw, flavor: b.flavor };
    } catch (e) {
      if (trace) {
        const entry = { get: label, ok: false, err: String(e?.message || e) };
        if (label !== key) entry.actual_key = key;
        trace.push(entry);
      }
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- helpers ---------- */
const isValidYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export const DEFAULT_MARKET_KEY = "h2h";
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

const allowSet = new Set([DEFAULT_MARKET_KEY]);
const envAllowedRaw = String(process.env.HISTORY_ALLOWED_MARKETS || "");
if (envAllowedRaw) {
  for (const part of envAllowedRaw.split(/[,\s]+/)) {
    const normalized = normalizeMarketKey(part);
    if (normalized) allowSet.add(normalized);
  }
}

const dedupKey = (e, normalizedMarketKey) => {
  const rawMarket = e?.market_key ?? e?.market ?? e?.market_label;
  const m = normalizedMarketKey ?? normalizeMarketKey(rawMarket);
  const pick = String(e?.pick || "").toLowerCase().trim();
  return `${e?.fixture_id || e?.id || "?"}__${m}__${pick}`;
};

function parseHistPayload(raw) {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      /* keep as string */
    }
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    if (Array.isArray(v.items)) return v.items;
    if (Array.isArray(v.history)) return v.history;
    if (v.data && Array.isArray(v.data.items)) return v.data.items;
  }
  return [];
}

function withHistoryMarketDisplay(entry, canonicalKey) {
  if (!entry || typeof entry !== "object") return entry;
  if (canonicalKey !== "1x2") return entry;
  const displayLabel = "1X2";
  const clone = { ...entry };
  clone.market = "1x2";
  clone.market_label = displayLabel;
  if ("market_display" in clone) clone.market_display = displayLabel;
  if ("marketDisplay" in clone) clone.marketDisplay = displayLabel;
  if ("marketName" in clone) clone.marketName = displayLabel;
  if ("marketKey" in clone) clone.marketKey = "1x2";
  if ("market_slug" in clone) clone.market_slug = "1x2";
  if ("marketSlug" in clone) clone.marketSlug = "1x2";
  return clone;
}

function normalizeSelection(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  if (lower === "home" || lower === "away" || lower === "draw") {
    return lower;
  }
  return lower;
}

function filterAllowed(arr) {
  const by = new Map();
  for (const e of arr || []) {
    if (!e || typeof e !== "object") continue;

    const rawMarketValue = e?.market_key ?? e?.market ?? e?.market_label ?? "";
    const rawMarketString = rawMarketValue == null ? "" : String(rawMarketValue);
    const marketRaw = rawMarketString.toLowerCase();
    let normalizedMarket = marketRaw === "1x2" ? "h2h" : marketRaw;
    if (normalizedMarket) {
      normalizedMarket = normalizeMarketKey(normalizedMarket);
      if (normalizedMarket === "1x2") normalizedMarket = "h2h";
    }

    const pickValue =
      e?.pick ??
      e?.selection ??
      e?.selection_key ??
      e?.selectionKey ??
      e?.pick_label ??
      e?.pickLabel ??
      "";
    const normalizedPick = normalizeSelection(pickValue);

    const teams = e?.teams;
    const hasTeams = Boolean(
      (teams && (teams.home || teams.away)) ||
        e?.home ||
        e?.away ||
        e?.home_name ||
        e?.away_name ||
        e?.homeName ||
        e?.awayName ||
        e?.home_id ||
        e?.away_id ||
        e?.homeId ||
        e?.awayId
    );

    if (!normalizedMarket && normalizedPick && hasTeams) {
      normalizedMarket = "h2h";
    }

    if (!normalizedMarket) continue;
    if (!allowSet.has(normalizedMarket)) continue;

    const prepared = { ...e };
    if (!prepared.market_key) {
      prepared.market_key = rawMarketString || normalizedMarket;
    }
    if (!prepared.market && normalizedMarket === "h2h") {
      prepared.market = "h2h";
    }

    const finalPick = normalizedPick || normalizeSelection(prepared.pick ?? "");
    if (finalPick) {
      prepared.pick = finalPick;
      prepared.selection = finalPick;
    }

    const canonical = normalizedMarket === "h2h" ? "1x2" : normalizedMarket;
    const displayReady =
      normalizedMarket === "h2h"
        ? withHistoryMarketDisplay(prepared, canonical)
        : prepared;
    const k = dedupKey(displayReady, canonical);
    if (!by.has(k)) by.set(k, displayReady);
  }
  return Array.from(by.values());
}

async function loadHistoryForDay(ymd, trace, wantDebug = false) {
  const histKey = `hist:${ymd}`;
  const { raw: histRespRaw } = await kvGETraw(histKey, trace);

  let sourceUsed = null;
  let arr = parseHistPayload(histRespRaw);
  if (Array.isArray(arr) && arr.length > 0) {
    sourceUsed = "hist";
  }

  const histDayKey = `hist:day:${ymd}`;
  let rawHistDay = null;
  if (!Array.isArray(arr) || arr.length === 0) {
    const resp = await kvGETraw(histDayKey, trace);
    rawHistDay = resp.raw;
    const fromHistDay = parseHistPayload(rawHistDay);
    if (fromHistDay.length > 0) {
      arr = fromHistDay;
      sourceUsed = "hist_day";
    }
  }

  const unionKey = `vb:day:${ymd}:union`;
  let unionRespRaw = null;
  let unionLen = 0;
  if (!Array.isArray(arr) || arr.length === 0) {
    const { raw } = await kvGETraw(unionKey, trace);
    unionRespRaw = raw;
    const fromUnion = parseHistPayload(unionRespRaw);
    unionLen = Array.isArray(fromUnion) ? fromUnion.length : 0;
    if (unionLen > 0) {
      arr = fromUnion;
      sourceUsed = "union";
    }
  }

  let combRespRaw = null;
  let combinedLen = 0;
  if (!Array.isArray(arr) || arr.length === 0) {
    const { raw } = await kvGETraw(`vb:day:${ymd}:combined`, trace);
    combRespRaw = raw;
    const fromCombined = parseHistPayload(raw);
    combinedLen = Array.isArray(fromCombined) ? fromCombined.length : 0;
    if (combinedLen > 0) {
      arr = fromCombined;
      sourceUsed = "combined";
    }
  }

  const before = Array.isArray(arr) ? arr.length : 0;

  const histDayValue = toJson(rawHistDay);
  const histDayItems = arrFromAny(histDayValue);
  const histValue = toJson(histRespRaw);
  const histItems = arrFromAny(histValue);
  const unionValue = toJson(unionRespRaw);
  const unionItems = arrFromAny(unionValue);
  const combValue = toJson(combRespRaw);
  const combItems = arrFromAny(combValue);

  let meta = null;
  if (wantDebug) {
    meta = {
      hist_day: {
        json: { ...histDayValue.meta },
        array: { ...histDayItems.meta },
      },
      hist: {
        json: { ...histValue.meta },
        array: { ...histItems.meta },
      },
      union: {
        json: { ...unionValue.meta },
        array: { ...unionItems.meta },
      },
      combined: {
        json: { ...combValue.meta },
        array: { ...combItems.meta },
      },
    };
  }

  return {
    items: Array.isArray(arr) ? arr : [],
    sources: {
      hist_day: rawHistDay !== null,
      hist: histRespRaw !== null,
      union: unionRespRaw !== null,
      combined: combRespRaw !== null,
    },
    usedSource: sourceUsed,
    unionLen,
    combinedLen,
    meta,
    before,
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
      const { items, sources, usedSource, meta, unionLen, combinedLen } =
        await loadHistoryForDay(day, trace, wantDebug);
      daySources[day] = {
        ...sources,
        used: usedSource,
        union_len: unionLen,
        combined_len: combinedLen,
      };
      if (wantDebug && meta) {
        dayMeta[day] = meta;
      }
      aggregated.push(...items);
    }

    const beforeFilter = aggregated.length;
    const items = filterAllowed(aggregated);
    const afterFilter = items.length;
    const roi = computeRoi(items);

    const usedList = Object.values(daySources)
      .map((s) => s?.used)
      .filter((v) => typeof v === "string" && v);
    let filterSourceUsed = null;
    if (usedList.length) {
      const priority = ["hist_day", "hist", "union", "combined"];
      for (const candidate of priority) {
        if (usedList.includes(candidate)) {
          filterSourceUsed = candidate;
          break;
        }
      }
      if (!filterSourceUsed) filterSourceUsed = usedList[0];
    }

    const historyFilterInfo = {
      before: beforeFilter,
      after: afterFilter,
      normalized: true,
      source_used: filterSourceUsed || "none",
    };
    if (wantDebug) {
      historyFilterInfo.sources_used = Object.fromEntries(
        Object.entries(daySources).map(([d, s]) => [d, s?.used || null])
      );
    }

    trace.push({ history_filter: historyFilterInfo });

    const singleYmd = ymd || (queriedDays.length ? queriedDays[0] : null);
    const debugInfo = {
      trace,
      allowed: Array.from(allowSet),
      day_sources: daySources,
      day_meta: wantDebug ? dayMeta : null,
    };
    if (singleYmd && daySources[singleYmd]) {
      debugInfo.sourceUsed = daySources[singleYmd].used ?? null;
      debugInfo.union_len = daySources[singleYmd].union_len ?? null;
      debugInfo.combined_len = daySources[singleYmd].combined_len ?? null;
    }
    if (wantDebug) {
      debugInfo.history_filter = {
        ...(debugInfo.history_filter || {}),
        ...historyFilterInfo,
      };
    }

    return res.status(200).json({
      ok: true,
      ymd: singleYmd,
      queried_days: queriedDays,
      count: items.length,
      source: daySources,
      roi,
      history: items,
      debug: debugInfo,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
