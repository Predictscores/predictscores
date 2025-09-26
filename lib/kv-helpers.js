// lib/kv-helpers.js
// Shared helpers for working with Vercel KV and Upstash Redis REST APIs.

const CLEARED_STRING_MARKERS = new Set(["null", "undefined", "nil", "none"]);

const PRODUCTION_MISCONFIG_CODE = "kv_env_missing_production_tokens";

class KvEnvMisconfigurationError extends Error {
  constructor(meta = {}) {
    super("Confirm env vars present in Production");
    this.name = "KvEnvMisconfigurationError";
    this.code = PRODUCTION_MISCONFIG_CODE;
    this.meta = meta && typeof meta === "object" ? meta : {};
  }
}

const ALT_ENV_SUFFIXES = [
  "_DEVELOPMENT",
  "_DEV",
  "_PREVIEW",
  "_STAGING",
  "_STAGE",
  "_TEST",
  "_QA",
  "_SANDBOX",
  "_LAB",
  "_LABS",
  "_NONPROD",
  "_NON_PROD",
];

function collectAltEnvKvConfig(env) {
  const configured = [];
  if (!env || typeof env !== "object") return configured;
  for (const [key, rawValue] of Object.entries(env)) {
    if (!rawValue) continue;
    if (!key || typeof key !== "string") continue;
    const upperKey = key.toUpperCase();
    if (!upperKey.startsWith("KV_REST_API_") && !upperKey.startsWith("UPSTASH_REDIS_REST_")) {
      continue;
    }
    if (!ALT_ENV_SUFFIXES.some((suffix) => upperKey.endsWith(suffix))) continue;
    const value = typeof rawValue === "string" ? rawValue.trim() : String(rawValue || "").trim();
    if (!value) continue;
    configured.push(key);
  }
  return configured;
}

function trimKey(key) {
  return typeof key === "string" ? key.trim() : "";
}

function sanitizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function kvBackends() {
  const out = [];
  const vercelUrlRaw = process.env.KV_REST_API_URL || process.env.KV_URL;
  const vercelToken = process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN;
  const upstashUrlRaw = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (vercelUrlRaw && vercelToken) {
    out.push({ flavor: "vercel-kv", url: sanitizeUrl(vercelUrlRaw), token: vercelToken });
  }
  if (upstashUrlRaw && upstashToken) {
    out.push({ flavor: "upstash-redis", url: sanitizeUrl(upstashUrlRaw), token: upstashToken });
  }
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (out.length === 0 && vercelEnv === "production") {
    const configuredElsewhere = collectAltEnvKvConfig(process.env);
    if (configuredElsewhere.length > 0) {
      throw new KvEnvMisconfigurationError({ configuredElsewhere });
    }
  }
  return out;
}

function looksClearedString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const unquoted = trimmed.replace(/^"+|"+$/g, "").trim();
  if (!unquoted) return true;
  return CLEARED_STRING_MARKERS.has(unquoted.toLowerCase());
}

function safeJsonParse(raw) {
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  if (looksClearedString(trimmed)) return null;
  return raw;
}

function extractPreferredArrays(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object") return [];

  const preferredKeys = [
    "items",
    "value_bets",
    "valueBets",
    "value-bets",
    "valuebets",
    "bets",
    "entries",
    "picks",
    "list",
    "data",
    "normalized",
    "result",
    "models",
  ];

  for (const key of preferredKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  for (const key of preferredKeys) {
    const candidate = payload[key];
    if (candidate && typeof candidate === "object") {
      const nested = extractPreferredArrays(candidate);
      if (Array.isArray(nested) && nested.length) return nested;
    }
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }

  for (const value of Object.values(payload)) {
    if (value && typeof value === "object") {
      const nested = extractPreferredArrays(value);
      if (Array.isArray(nested) && nested.length) return nested;
    }
  }

  return [];
}

function extractArray(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;

  const queue = [{ node: payload, depth: 0 }];
  const visited = new Set();
  const arrays = [];
  const maxDepth = 6;

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!node || depth > maxDepth) continue;
    if (typeof node === "string") {
      const parsed = safeJsonParse(node);
      if (parsed && typeof parsed === "object") {
        queue.push({ node: parsed, depth: depth + 1 });
      }
      continue;
    }
    if (typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    if (Array.isArray(node)) {
      arrays.push(node);
      for (const part of node) {
        if (part && typeof part === "object") {
          queue.push({ node: part, depth: depth + 1 });
        } else if (typeof part === "string") {
          const parsed = safeJsonParse(part);
          if (parsed && typeof parsed === "object") {
            queue.push({ node: parsed, depth: depth + 1 });
          }
        }
      }
      continue;
    }

    const keys = Object.keys(node);
    const numericKeys = keys.filter((k) => /^\d+$/.test(k));
    if (numericKeys.length && numericKeys.length === keys.length) {
      const arr = numericKeys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => node[k]);
      arrays.push(arr);
      queue.push({ node: arr, depth: depth + 1 });
      continue;
    }

    const preferred = extractPreferredArrays(node);
    if (Array.isArray(preferred) && preferred.length) {
      arrays.push(preferred);
    }

    for (const value of Object.values(node)) {
      if (!value) continue;
      if (typeof value === "object" || typeof value === "string") {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  if (!arrays.length && payload && typeof payload === "object") {
    const values = Object.values(payload).filter((it) => Array.isArray(it));
    if (values.length) return values[0];
  }

  let best = null;
  let bestScore = -1;
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    const objects = arr.filter((it) => it && typeof it === "object");
    const score = objects.length;
    if (score > bestScore) {
      bestScore = score;
      best = arr;
    }
  }

  return Array.isArray(best) ? best : [];
}

function countItems(payload) {
  const arr = extractArray(payload);
  return Array.isArray(arr) ? arr.length : 0;
}

async function readKeyFromBackends(key, options = {}) {
  const { backends = kvBackends(), parseJson = true, trace } = options;
  const tried = [];
  let chosen = null;

  for (const backend of backends) {
    let result = {
      key,
      flavor: backend.flavor,
      ok: false,
      status: null,
      hit: false,
      count: 0,
      value: null,
      error: null,
      items: [],
    };
    try {
      const url = `${backend.url}/get/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${backend.token}` },
        cache: "no-store",
      });
      result.ok = res.ok;
      result.status = res.status;
      if (res.ok) {
        const json = await res.json().catch(() => null);
        const raw = json?.result ?? json?.value ?? null;
        const value = parseJson ? safeJsonParse(raw) : raw;
        result.value = value;
        if (value != null && !looksClearedString(value)) {
          result.hit = true;
        }
        const arr = extractArray(value);
        if (Array.isArray(arr)) {
          result.items = arr;
          result.count = arr.length;
          if (arr.length > 0) {
            result.hit = true;
          }
        }
      } else {
        result.error = `http_${res.status}`;
      }
    } catch (err) {
      result.ok = false;
      result.error = String(err?.message || err);
    }

    tried.push(result);

    if (!chosen) {
      if (result.count > 0) {
        chosen = result;
      } else if (result.hit) {
        chosen = result;
      }
    } else if (chosen.count <= 0 && result.count > 0) {
      chosen = result;
    }
  }

  if (trace) {
    trace.push({ kv_get: { key, tried: tried.map((r) => ({ flavor: r.flavor, ok: r.ok, hit: r.hit, count: r.count, error: r.error })) } });
  }

  return {
    key,
    tried,
    value: chosen ? chosen.value : null,
    items: chosen ? chosen.items : [],
    flavor: chosen ? chosen.flavor : null,
    hit: Boolean(chosen && chosen.hit),
    count: chosen ? chosen.count : 0,
  };
}

async function writeKeyToBackends(key, value, options = {}) {
  const { backends = kvBackends(), trace } = options;
  const saves = [];
  for (const backend of backends) {
    try {
      const bodyValue = typeof value === "string" ? value : JSON.stringify(value);
      const url = `${backend.url}/set/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${backend.token}`,
        },
        body: JSON.stringify({ value: bodyValue }),
      });
      saves.push({ flavor: backend.flavor, ok: res.ok, status: res.status });
    } catch (err) {
      saves.push({ flavor: backend.flavor, ok: false, error: String(err?.message || err) });
    }
  }
  if (trace) {
    trace.push({ kv: "set", key, saves });
  }
  return saves;
}

async function saveCombinedAlias({ ymd, payload, from = "union", trace }) {
  const key = `vb:day:${trimKey(ymd)}:combined`;
  const count = countItems(payload);
  if (trace) {
    trace.push({ alias_combined: { from, count } });
  }
  if (!trimKey(ymd) || count <= 0) {
    return { key, count, wrote: false, saves: [] };
  }
  const saves = await writeKeyToBackends(key, payload, { trace });
  const wrote = saves.some((s) => s.ok);
  return { key, count, wrote, saves };
}

module.exports = {
  kvBackends,
  readKeyFromBackends,
  writeKeyToBackends,
  saveCombinedAlias,
  safeJsonParse,
  extractArray,
  countItems,
  looksClearedString,
  KvEnvMisconfigurationError,
  PRODUCTION_MISCONFIG_CODE,
};
