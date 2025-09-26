#!/usr/bin/env node

const DEFAULT_BASE = "http://localhost:3000";
const TARGET_RATIO = 0.7;

const baseEnv = (process.env.BASE || "").trim();
const base = (baseEnv || DEFAULT_BASE).replace(/\/+$/, "");

const fail = (message) => {
  console.error(`[smoke-tiers] ${message}`);
  process.exit(1);
};

async function fetchJson(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    fail(`Request to ${path} failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json().catch(() => null);
  if (!payload) {
    fail(`Invalid JSON payload from ${path}`);
  }
  return payload;
}

function computeTierRatio(items = []) {
  const fixtureTier = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item == null) continue;
    const fixtureId = item.fixture_id ?? item.fixtureId ?? item.fixture?.id ?? null;
    if (fixtureId == null) continue;
    const tier = typeof item.tier === "string" && item.tier ? item.tier : "UNK";
    if (!fixtureTier.has(fixtureId)) {
      fixtureTier.set(fixtureId, tier);
    }
  }
  const total = fixtureTier.size;
  if (total === 0) {
    return { ratio: 0, total: 0 };
  }
  const tier1 = Array.from(fixtureTier.values()).filter((tier) => tier === "T1").length;
  return { ratio: tier1 / total, total };
}

function extractReportedTier(debugPayload) {
  const candidates = [
    debugPayload?.tiers?.T1,
    debugPayload?.summary?.tiers?.T1,
    debugPayload?.tier1,
  ].filter(Boolean);
  return candidates[0] || null;
}

function pickNumericCandidate(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

try {
  const locked = await fetchJson("/api/value-bets-locked?slot=am");
  if (!Array.isArray(locked.items)) {
    fail("Locked response missing 'items' array.");
  }
  if (locked.items.length === 0) {
    fail("Locked response returned zero items.");
  }

  const { ratio, total } = computeTierRatio(locked.items);
  const shortfall = ratio >= TARGET_RATIO ? 0 : TARGET_RATIO - ratio;

  if (ratio < TARGET_RATIO) {
    console.warn(
      `[smoke-tiers] Tier 1 ratio below target: ratio=${ratio.toFixed(3)} target=${TARGET_RATIO.toFixed(2)} shortfall=${shortfall.toFixed(3)}`
    );
  }

  const debug = await fetchJson("/api/debug/tiers");
  const tierInfo = extractReportedTier(debug);
  if (!tierInfo) {
    fail("/api/debug/tiers payload missing Tier 1 summary.");
  }

  const reportedRatio = pickNumericCandidate(tierInfo, ["actual", "actual_ratio", "ratio"]);
  const reportedShortfall = pickNumericCandidate(tierInfo, ["shortfall", "shortfall_ratio", "gap"]);

  if (reportedRatio == null) {
    fail("Tier 1 summary missing actual ratio field.");
  }

  if (Math.abs(reportedRatio - ratio) > 0.05) {
    fail(
      `Tier 1 ratio mismatch: computed=${ratio.toFixed(3)} reported=${reportedRatio.toFixed(3)}`
    );
  }

  if (reportedShortfall != null) {
    if (Math.abs(reportedShortfall - shortfall) > 0.05) {
      fail(
        `Tier 1 shortfall mismatch: computed=${shortfall.toFixed(3)} reported=${reportedShortfall.toFixed(3)}`
      );
    }
  } else if (shortfall > 0) {
    fail("Tier 1 shortfall missing while ratio below target.");
  }

  console.log(
    `[smoke-tiers] fixtures=${total} ratio=${ratio.toFixed(3)} shortfall=${shortfall.toFixed(3)}`
  );
} catch (error) {
  fail(error?.message || String(error));
}
