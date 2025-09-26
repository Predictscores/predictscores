// pages/api/debug/tiers.js
const { kvBackends, readKeyFromBackends } = require("../../../lib/kv-helpers");
const { isLeagueDenied, getLeagueTargetRatio } = require("../../../lib/leaguesConfig");
const { resolveLeagueTier } = require("../../../lib/learning/runtime");

export const config = { api: { bodyParser: false } };

function normalizeTierKey(key) {
  if (!key && key !== 0) return null;
  const str = String(key).trim().toUpperCase();
  if (!str) return null;
  if (str === "T1" || str === "TIER1" || str === "1") return "T1";
  if (str === "T2" || str === "TIER2" || str === "2") return "T2";
  if (str === "T3" || str === "TIER3" || str === "3") return "T3";
  if (str.includes("DENY")) return "DENIED";
  if (str.includes("OTHER")) return "OTHER";
  if (str.includes("UNK")) return "UNKNOWN";
  return null;
}

function toCount(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) {
    return num;
  }
  return null;
}

function mergeCounts(target, source) {
  if (!source || typeof source !== "object") return false;
  let merged = false;
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const tierKey = normalizeTierKey(rawKey);
    if (!tierKey) continue;
    let count = null;
    if (typeof rawValue === "number") {
      count = toCount(rawValue);
    } else if (rawValue && typeof rawValue === "object") {
      if (rawValue.count != null) count = toCount(rawValue.count);
      if (count == null && rawValue.picked != null) count = toCount(rawValue.picked);
      if (count == null && rawValue.total != null) count = toCount(rawValue.total);
      if (count == null && rawValue.value != null) count = toCount(rawValue.value);
    }
    if (count != null) {
      target[tierKey] = (target[tierKey] || 0) + count;
      merged = true;
    }
  }
  return merged;
}

function ensureCountsShape(counts) {
  return {
    T1: Number(counts?.T1 || 0),
    T2: Number(counts?.T2 || 0),
    T3: Number(counts?.T3 || 0),
    DENIED: Number(counts?.DENIED || 0),
    UNKNOWN: Number(counts?.UNKNOWN || counts?.OTHER || 0),
  };
}

function extractLeagueCandidate(node) {
  if (!node || typeof node !== "object") return null;
  if (node.league && typeof node.league === "object") return node.league;
  if (node.fixture && typeof node.fixture === "object" && node.fixture.league) {
    return node.fixture.league;
  }
  const idCandidates = [
    node.league_id,
    node.leagueId,
    node.league?.id,
    node.competition_id,
    node.competitionId,
    node.meta?.league_id,
    node.meta?.leagueId,
  ];
  let id = null;
  for (const cand of idCandidates) {
    const num = Number(cand);
    if (Number.isFinite(num)) {
      id = num;
      break;
    }
  }
  const nameCandidates = [
    node.league_name,
    node.leagueName,
    node.league?.name,
    node.league_title,
    node.competition,
    node.competition_name,
    node.tournament,
    node.name,
    node.meta?.league_name,
    node.meta?.leagueName,
    node.meta?.league?.name,
  ];
  let name = "";
  for (const cand of nameCandidates) {
    if (typeof cand === "string" && cand.trim()) {
      name = cand.trim();
      break;
    }
  }
  if (id == null && !name && node.meta && typeof node.meta === "object") {
    return extractLeagueCandidate(node.meta);
  }
  if (id == null && !name) return null;
  const league = {};
  if (id != null) league.id = id;
  if (name) league.name = name;
  return league;
}

function computeCountsFromArray(arr) {
  const counts = { T1: 0, T2: 0, T3: 0, DENIED: 0, UNKNOWN: 0 };
  if (!Array.isArray(arr)) return counts;
  for (const item of arr) {
    if (!item || typeof item !== "object") {
      counts.UNKNOWN += 1;
      continue;
    }
    const league = extractLeagueCandidate(item) || item;
    if (league && isLeagueDenied(league)) {
      counts.DENIED += 1;
      continue;
    }
    const tier = resolveLeagueTier(league);
    if (tier === "T1" || tier === "T2" || tier === "T3") {
      counts[tier] += 1;
    } else {
      counts.UNKNOWN += 1;
    }
  }
  return counts;
}

function findArrayCandidates(payload) {
  if (!payload) return [];
  const candidates = [];
  const keys = [
    "picks",
    "items",
    "value_bets",
    "valueBets",
    "list",
    "entries",
    "baseline",
    "learned",
  ];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value) && value.length) {
      candidates.push(value);
    }
  }
  if (payload.meta && Array.isArray(payload.meta.picks) && payload.meta.picks.length) {
    candidates.push(payload.meta.picks);
  }
  if (Array.isArray(payload)) candidates.push(payload);
  return candidates;
}

function deriveCounts(payload) {
  const counts = { T1: 0, T2: 0, T3: 0, DENIED: 0, UNKNOWN: 0 };
  if (!payload || typeof payload !== "object") {
    return ensureCountsShape(counts);
  }

  const directSources = [
    payload.pickedByTier,
    payload.picked_by_tier,
    payload.counts,
    payload.counts?.byTier,
    payload.byTier,
    payload.tiers,
    payload.metrics?.byTier,
    payload.metrics?.pickedByTier,
    payload.telemetry?.byTier,
    payload.telemetry?.pickedByTier,
    payload.meta?.byTier,
    payload.meta?.pickedByTier,
  ];

  for (const source of directSources) {
    if (mergeCounts(counts, source)) {
      return ensureCountsShape(counts);
    }
  }

  const arrays = findArrayCandidates(payload);
  let best = null;
  for (const arr of arrays) {
    const computed = computeCountsFromArray(arr);
    const total =
      computed.T1 + computed.T2 + computed.T3 + computed.DENIED + computed.UNKNOWN;
    if (total <= 0) continue;
    if (!best || total > best.total) {
      best = { counts: computed, total };
    }
  }

  if (best) {
    return ensureCountsShape(best.counts);
  }

  return ensureCountsShape(counts);
}

function computeShortfall(counts) {
  const total = counts.T1 + counts.T2 + counts.T3;
  const targetRatio = getLeagueTargetRatio("T1");
  const actualRatio = total > 0 ? counts.T1 / total : null;
  if (!Number.isFinite(targetRatio) || total <= 0) {
    return {
      shortfall: null,
      targetRatio,
      actualRatio,
      targetCount: null,
    };
  }
  const targetCount = targetRatio * total;
  const missing = targetCount - counts.T1;
  return {
    shortfall: missing > 0 ? Number(missing.toFixed(3)) : 0,
    targetRatio,
    actualRatio: Number.isFinite(actualRatio) ? Number(actualRatio.toFixed(3)) : actualRatio,
    targetCount: Number(targetCount.toFixed(3)),
  };
}

function buildKeyCandidates({ key, ymd, slot }) {
  if (key) return [key];
  const keys = [];
  if (ymd && slot) {
    keys.push(`vb:telemetry:tiers:${ymd}:${slot}`);
  }
  if (ymd) {
    keys.push(`vb:telemetry:tiers:${ymd}`);
  }
  if (slot) {
    keys.push(`vb:telemetry:tiers:latest:${slot}`);
  }
  keys.push("vb:telemetry:tiers:last");
  keys.push("vb:telemetry:tiers:latest");
  keys.push("vb:selector:tiers:last");
  keys.push("vb:selector:tiers:latest");
  return keys;
}

function pickSlotAuto(now, tz = "Europe/Belgrade") {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
    const hourPart = fmt.formatToParts(now).find((p) => p.type === "hour");
    const hour = hourPart ? Number(hourPart.value) : now.getUTCHours();
    if (hour < 10) return "late";
    if (hour < 15) return "am";
    return "pm";
  } catch {
    const hour = now.getUTCHours();
    if (hour < 10) return "late";
    if (hour < 15) return "am";
    return "pm";
  }
}

function ymdInTz(now, tz = "Europe/Belgrade") {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(now);
  } catch {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

export default async function handler(req, res) {
  const trace = [];
  try {
    const backends = kvBackends();
    if (!Array.isArray(backends) || backends.length === 0) {
      return res.status(200).json({ ok: false, error: "KV env missing" });
    }

    const tz = process.env.TZ_DISPLAY || "Europe/Belgrade";
    const now = new Date();
    const ymd = String(req.query.ymd || "").trim() || ymdInTz(now, tz);
    let slot = String(req.query.slot || "").trim().toLowerCase();
    if (!slot) slot = pickSlotAuto(now, tz);
    const overrideKey = req.query.key ? String(req.query.key).trim() : "";

    const keysToTry = buildKeyCandidates({ key: overrideKey, ymd, slot });
    const keyTrace = [];
    let doc = null;
    let usedKey = null;

    for (const candidate of keysToTry) {
      if (!candidate) continue;
      const read = await readKeyFromBackends(candidate, { backends, parseJson: true, trace });
      keyTrace.push({ key: candidate, hit: Boolean(read?.hit), count: Number(read?.count || 0) });
      if (read && read.value != null) {
        doc = read.value;
        usedKey = candidate;
        break;
      }
    }

    if (!doc) {
      console.info("[debug/tiers] telemetry missing", { keysTried: keyTrace });
      return res.status(200).json({
        ok: false,
        error: "Telemetry not found",
        ymd,
        slot,
        keysTried: keyTrace,
        debug: { trace },
      });
    }

    const pickedByTier = deriveCounts(doc);
    const totalPicks = pickedByTier.T1 + pickedByTier.T2 + pickedByTier.T3;
    const shortfallInfo = computeShortfall(pickedByTier);
    const shortfallTier1 = shortfallInfo.shortfall;

    console.info("[debug/tiers] parsed telemetry", {
      key: usedKey,
      totalPicks,
      pickedByTier,
      shortfallTier1,
    });

    return res.status(200).json({
      ok: true,
      key: usedKey,
      ymd,
      slot,
      pickedByTier,
      totalPicks,
      shortfallTier1,
      ratios: {
        targetT1: shortfallInfo.targetRatio,
        actualT1: shortfallInfo.actualRatio,
      },
      targetCountT1: shortfallInfo.targetCount,
      keysTried: keyTrace,
      debug: { trace },
    });
  } catch (error) {
    console.info("[debug/tiers] error", { error: error?.message || String(error) });
    return res.status(500).json({
      ok: false,
      error: error?.message || String(error),
      debug: { trace },
    });
  }
}
