const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  tiers: {
    T1: {
      ids: [39, 40, 61, 78, 135, 140, 2, 3, 848],
      patterns: [
        "Premier\\s+League",
        "La\\s+Liga",
        "Serie\\s+A",
        "Bundesliga",
        "Ligue\\s+1",
        "Champions\\s+League",
        "UEFA\\s*Champ",
      ],
      target_ratio: 0.7,
    },
    T2: {
      ids: [41, 42, 88, 94, 95, 96, 99, 103, 144, 208, 210],
      patterns: [
        "Championship",
        "Eredivisie",
        "Primeira",
        "Liga\\s+Portugal",
        "Super\\s+Lig",
        "Pro\\s+League",
        "Bundesliga\\s+2",
        "Serie\\s+B",
        "LaLiga\\s+2",
        "Ligue\\s+2",
        "Eerste\\s+Divisie",
      ],
      target_ratio: 0.2,
    },
    T3: {
      ids: [],
      patterns: [],
      target_ratio: 0.1,
    },
  },
  denylist_patterns: [
    "U-?\\d{2}",
    "youth",
    "reserves?",
    "women",
    "amateur",
    "friendlies?\\s*B",
    "futsal",
  ],
};

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function compilePattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== "string") return null;
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function normalizeTier(key, rawTier = {}, fallbackTier = {}) {
  const idsSource = Array.isArray(rawTier.ids) ? rawTier.ids : fallbackTier.ids || [];
  const ids = idsSource
    .map((id) => toFiniteNumber(id))
    .filter((id) => id != null);

  const patternSource = Array.isArray(rawTier.patterns)
    ? rawTier.patterns
    : fallbackTier.patterns || [];
  const regexes = patternSource
    .map((p) => compilePattern(p))
    .filter(Boolean);

  const rawTarget =
    rawTier.target_ratio ??
    rawTier.targetRatio ??
    fallbackTier.target_ratio ??
    fallbackTier.targetRatio;
  const targetRatio = toFiniteNumber(rawTarget);

  return {
    key,
    ids,
    idSet: new Set(ids),
    patterns: patternSource,
    regexes,
    targetRatio: Number.isFinite(targetRatio) ? targetRatio : null,
  };
}

function normalizeDenylist(rawList, fallbackList = []) {
  const src = Array.isArray(rawList) ? rawList : fallbackList;
  const patterns = src.filter((p) => typeof p === "string" && p);
  const regexes = patterns.map((p) => compilePattern(p)).filter(Boolean);
  return { patterns, regexes };
}

function normalizeConfig(raw = {}) {
  const tiers = {};
  const rawTiers = raw && typeof raw === "object" ? raw.tiers || {} : {};
  const fallbackTiers = DEFAULT_CONFIG.tiers;
  const tierKeys = new Set([
    ...Object.keys(fallbackTiers),
    ...Object.keys(rawTiers || {}),
  ]);
  for (const key of tierKeys) {
    tiers[key] = normalizeTier(key, rawTiers[key] || {}, fallbackTiers[key] || {});
  }
  const denylist = normalizeDenylist(raw.denylist_patterns, DEFAULT_CONFIG.denylist_patterns);
  return { tiers, denylist };
}

const DEFAULT_NORMALIZED = normalizeConfig(DEFAULT_CONFIG);

let cachedConfig = null;
let cachedMtime = null;
let cachedPath = null;

function configPath() {
  return path.join(process.cwd(), "config", "leagues.tiers.json");
}

function loadConfigFromDisk(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

function getLeaguesConfig() {
  const filePath = configPath();
  try {
    const stats = fs.statSync(filePath);
    if (!cachedConfig || cachedPath !== filePath || cachedMtime !== stats.mtimeMs) {
      const loaded = loadConfigFromDisk(filePath) || DEFAULT_NORMALIZED;
      cachedConfig = loaded;
      cachedMtime = stats.mtimeMs;
      cachedPath = filePath;
    }
  } catch {
    if (!cachedConfig) {
      cachedConfig = DEFAULT_NORMALIZED;
      cachedPath = filePath;
      cachedMtime = null;
    }
  }
  return cachedConfig || DEFAULT_NORMALIZED;
}

function extractLeagueMeta(league) {
  if (league == null) return { id: null, name: "" };

  if (typeof league === "number") {
    return Number.isFinite(league) ? { id: league, name: "" } : { id: null, name: "" };
  }

  if (typeof league === "string") {
    const trimmed = league.trim();
    if (!trimmed) return { id: null, name: "" };
    const asNumber = toFiniteNumber(trimmed);
    if (asNumber != null) return { id: asNumber, name: trimmed };
    return { id: null, name: trimmed };
  }

  if (typeof league === "object") {
    if (league.league && typeof league.league === "object") {
      return extractLeagueMeta(league.league);
    }
    const idCandidates = [league.id, league.league_id, league.leagueId];
    let id = null;
    for (const cand of idCandidates) {
      const num = toFiniteNumber(cand);
      if (num != null) {
        id = num;
        break;
      }
    }
    const nameCandidates = [
      league.name,
      league.league_name,
      league.leagueName,
      league.competition,
      league.tournament,
      league.display,
    ];
    let name = "";
    for (const cand of nameCandidates) {
      if (typeof cand === "string") {
        const trimmed = cand.trim();
        if (trimmed) {
          name = trimmed;
          break;
        }
      }
    }
    return { id, name };
  }

  return { id: null, name: "" };
}

function pickRegexes(config, tierKey, override) {
  if (override) {
    const arr = Array.isArray(override) ? override : [override];
    return arr
      .map((item) => {
        if (item instanceof RegExp) return item;
        if (typeof item === "string") return compilePattern(item);
        return null;
      })
      .filter(Boolean);
  }
  return config.tiers[tierKey]?.regexes || [];
}

function matchLeagueTier(league, options = {}) {
  const config = getLeaguesConfig();
  const { id, name } = extractLeagueMeta(league);

  if (id != null) {
    for (const key of Object.keys(config.tiers)) {
      if (config.tiers[key]?.idSet?.has(id)) {
        return key;
      }
    }
  }

  if (name) {
    const { regexOverrides = {} } = options;
    for (const key of Object.keys(config.tiers)) {
      const regexes = pickRegexes(config, key, regexOverrides[key]);
      if (regexes.some((re) => re.test(name))) {
        return key;
      }
    }
  }

  return null;
}

function resolveLeagueTierKey(league, options = {}) {
  const matched = matchLeagueTier(league, options);
  return matched || "T3";
}

function getLeagueTargetRatio(tierKey) {
  const config = getLeaguesConfig();
  const tier = config.tiers[tierKey];
  return typeof tier?.targetRatio === "number" ? tier.targetRatio : null;
}

function isLeagueDenied(league) {
  const config = getLeaguesConfig();
  const { name } = extractLeagueMeta(league);
  if (!name) return false;
  return config.denylist.regexes.some((re) => re.test(name));
}

module.exports = {
  getLeaguesConfig,
  matchLeagueTier,
  resolveLeagueTierKey,
  getLeagueTargetRatio,
  isLeagueDenied,
};
