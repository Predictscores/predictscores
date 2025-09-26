function describeType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function isEmptyValue(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function detectArraySource(input) {
  if (Array.isArray(input)) return "self";
  if (input && typeof input === "object") {
    if (Array.isArray(input.items)) return "items";
    if (Array.isArray(input.history)) return "history";
    if (Array.isArray(input.list)) return "list";
  }
  return "none";
}

function attemptParse(source) {
  if (typeof source !== "string") {
    return { parsed: false };
  }
  const trimmed = source.trim();
  if (!trimmed) {
    return { parsed: false };
  }
  try {
    JSON.parse(trimmed);
    return { parsed: true };
  } catch {
    return { parsed: false, error: "invalid_json" };
  }
}

export function jsonMeta(source, value) {
  const sourceType = describeType(source);
  const valueType = describeType(value);
  const { parsed, error } = attemptParse(source);
  const meta = {
    sourceType,
    valueType,
    sourceIsString: sourceType === "string",
    sourceIsObject: sourceType === "object",
    sourceIsArray: sourceType === "array",
    valueIsObject: valueType === "object",
    valueIsArray: valueType === "array",
    parsed,
    empty: isEmptyValue(value),
  };
  if (error) meta.error = error;
  return meta;
}

export function arrayMeta(sourceValue, array, baseMeta) {
  const meta = baseMeta ? { ...baseMeta } : jsonMeta(sourceValue, sourceValue);
  meta.valueType = "array";
  meta.valueIsArray = true;
  meta.valueIsObject = false;
  meta.empty = Array.isArray(array) ? array.length === 0 : true;
  meta.arraySource = detectArraySource(sourceValue);
  meta.length = Array.isArray(array) ? array.length : 0;
  return meta;
}

function normalizeTierCounts(map) {
  const base = { T1: 0, T2: 0, T3: 0 };
  if (!map || typeof map !== "object") return base;
  for (const key of Object.keys(base)) {
    const value = Number(map[key]);
    base[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return base;
}

function normalizeExcludedPatterns(map) {
  if (!map || typeof map !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!trimmed) continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) continue;
    out[trimmed] = num;
  }
  return out;
}

function sanitizeKeyPart(part) {
  if (typeof part !== "string") return "";
  return part.trim();
}

function kvConfig() {
  const url = process.env.KV_REST_API_URL || "";
  const token =
    process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const trimmedUrl = url.replace(/\/+$/, "");
  if (!trimmedUrl || !token) {
    return null;
  }
  return { url: trimmedUrl, token };
}

async function kvSetJson(key, value) {
  const cfg = kvConfig();
  if (!cfg) return false;
  try {
    const bodyValue = typeof value === "string" ? value : JSON.stringify(value);
    const res = await fetch(`${cfg.url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ value: bodyValue }),
    });
    return res.ok;
  } catch (err) {
    console.warn("kv-meta: failed to write", key, String(err?.message || err));
    return false;
  }
}

async function kvGetJson(key) {
  const cfg = kvConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const raw = json?.result ?? json?.value ?? null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (raw && typeof raw === "object") return raw;
    return null;
  } catch (err) {
    console.warn("kv-meta: failed to read", key, String(err?.message || err));
    return null;
  }
}

const TIER_METRICS_PREFIX = "vb:metrics:tiers";

function computeTotals(counts) {
  return Object.values(counts || {}).reduce((acc, value) => {
    const num = Number(value);
    return acc + (Number.isFinite(num) ? num : 0);
  }, 0);
}

export async function storeTierMetrics({
  candidatesByTier,
  pickedByTier,
  shortfallTier1,
  excludedByPattern,
  ymd,
  slot,
  totalCandidates,
  totalPicked,
} = {}) {
  const normalizedCandidates = normalizeTierCounts(candidatesByTier);
  const normalizedPicked = normalizeTierCounts(pickedByTier);
  const normalizedExcluded = normalizeExcludedPatterns(excludedByPattern);
  const shortfall = Number(shortfallTier1);
  const payload = {
    ymd: sanitizeKeyPart(ymd) || null,
    slot: sanitizeKeyPart(slot) || null,
    recordedAt: new Date().toISOString(),
    candidatesByTier: normalizedCandidates,
    pickedByTier: normalizedPicked,
    shortfallTier1: Number.isFinite(shortfall) ? shortfall : 0,
    excludedByPattern: normalizedExcluded,
    totalCandidates:
      Number.isFinite(Number(totalCandidates))
        ? Number(totalCandidates)
        : computeTotals(normalizedCandidates),
    totalPicked:
      Number.isFinite(Number(totalPicked))
        ? Number(totalPicked)
        : computeTotals(normalizedPicked),
  };

  console.info("tier-metrics:store", payload);

  const keys = [];
  if (payload.ymd && payload.slot) {
    keys.push(`${TIER_METRICS_PREFIX}:${payload.ymd}:${payload.slot}`);
  }
  keys.push(`${TIER_METRICS_PREFIX}:last`);

  const saves = [];
  for (const key of keys) {
    const ok = await kvSetJson(key, payload);
    saves.push({ key, ok });
  }
  const stored = saves.some((s) => s.ok);
  return { stored, payload, saves };
}

export async function readTierMetrics({ ymd, slot } = {}) {
  const resolvedYmd = sanitizeKeyPart(ymd);
  const resolvedSlot = sanitizeKeyPart(slot).toLowerCase();
  let key = `${TIER_METRICS_PREFIX}:last`;
  if (resolvedYmd && ["late", "am", "pm"].includes(resolvedSlot)) {
    key = `${TIER_METRICS_PREFIX}:${resolvedYmd}:${resolvedSlot}`;
  }
  return kvGetJson(key);
}
