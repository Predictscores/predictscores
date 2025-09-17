const SUPPORTED_MARKETS = new Set(["1X2", "OU2.5", "BTTS", "HTFT"]);

function numberFrom(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pluck(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      cur = cur[key];
    }
  }
  return cur;
}

function firstNumberFromPaths(obj, paths) {
  for (const path of paths) {
    const arrPath = Array.isArray(path) ? path : [path];
    const val = pluck(obj, arrPath);
    const num = numberFrom(val);
    if (num != null) return num;
  }
  return null;
}

const FT_HOME_PATHS = [
  ["ft", "home"],
  ["ft", "Home"],
  ["ft", 0],
  ["fulltime", "home"],
  ["fulltime", "Home"],
  ["full_time", "home"],
  ["full_time", "Home"],
  ["score", "fulltime", "home"],
  ["score", "full_time", "home"],
  ["score", "ft", "home"],
  ["score", "ft", 0],
  ["goals", "fulltime", "home"],
  ["goals", "home"],
  "ft_home",
  "ftHome",
  "ftH",
];

const FT_AWAY_PATHS = [
  ["ft", "away"],
  ["ft", "Away"],
  ["ft", 1],
  ["fulltime", "away"],
  ["fulltime", "Away"],
  ["full_time", "away"],
  ["full_time", "Away"],
  ["score", "fulltime", "away"],
  ["score", "full_time", "away"],
  ["score", "ft", "away"],
  ["score", "ft", 1],
  ["goals", "fulltime", "away"],
  ["goals", "away"],
  "ft_away",
  "ftAway",
  "ftA",
];

const HT_HOME_PATHS = [
  ["ht", "home"],
  ["ht", "Home"],
  ["ht", 0],
  ["halftime", "home"],
  ["halftime", "Home"],
  ["half_time", "home"],
  ["half_time", "Home"],
  ["score", "ht", "home"],
  ["score", "ht", 0],
  ["score", "halftime", "home"],
  ["score", "half_time", "home"],
  ["goals", "halftime", "home"],
  "ht_home",
  "htHome",
  "htH",
];

const HT_AWAY_PATHS = [
  ["ht", "away"],
  ["ht", "Away"],
  ["ht", 1],
  ["halftime", "away"],
  ["halftime", "Away"],
  ["half_time", "away"],
  ["half_time", "Away"],
  ["score", "ht", "away"],
  ["score", "ht", 1],
  ["score", "halftime", "away"],
  ["score", "half_time", "away"],
  ["goals", "halftime", "away"],
  "ht_away",
  "htAway",
  "htA",
];

export function parseScore(raw) {
  if (!raw) return { ft: null, ht: null };
  try {
    const base = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!base || typeof base !== "object") return { ft: null, ht: null };

    const ftHome = firstNumberFromPaths(base, FT_HOME_PATHS);
    const ftAway = firstNumberFromPaths(base, FT_AWAY_PATHS);
    const htHome = firstNumberFromPaths(base, HT_HOME_PATHS);
    const htAway = firstNumberFromPaths(base, HT_AWAY_PATHS);

    const ft = ftHome != null && ftAway != null ? { home: ftHome, away: ftAway } : null;
    const ht = htHome != null && htAway != null ? { home: htHome, away: htAway } : null;

    return { ft, ht };
  } catch {
    return { ft: null, ht: null };
  }
}

function normalizeMarket(rawMarket) {
  if (rawMarket == null) return "";
  const trimmed = String(rawMarket).trim();
  if (!trimmed) return "";
  const upper = trimmed.toUpperCase();
  const collapsed = upper.replace(/\s+/g, "");
  const clean = collapsed.replace(/[-_/]/g, "");
  if (clean === "1X2") return "1X2";
  if (clean === "BTTS" || clean === "BTS") return "BTTS";
  if (clean === "HTFT") return "HTFT";
  if (clean === "OU25") return "OU2.5";
  return upper;
}

function normalizePickCode(rawCode, market) {
  if (rawCode == null) return null;
  let str = String(rawCode).trim();
  if (!str) return null;
  str = str.toUpperCase();
  if (str.includes(":")) {
    const parts = str.split(":");
    str = parts[parts.length - 1];
  }
  str = str.replace(/\s+/g, "");
  if (!str) return null;

  switch (market) {
    case "1X2": {
      str = str.replace(/[^0-9A-Z]/g, "");
      if (str.startsWith("1X2")) str = str.slice(3);
      if (str === "1" || str === "X" || str === "2") return str;
      if (str === "H" || str === "HOME") return "1";
      if (str === "A" || str === "AWAY") return "2";
      if (str === "D" || str === "DRAW") return "X";
      if (str.includes("HOME")) return "1";
      if (str.includes("AWAY")) return "2";
      if (str.includes("DRAW")) return "X";
      const match = str.match(/[12X]/);
      return match ? match[0] : null;
    }
    case "OU2.5": {
      str = str.replace(/[^A-Z0-9.]/g, "");
      if (str.startsWith("OU2.5")) str = str.slice(5);
      if (str.startsWith("OU25")) str = str.slice(4);
      if (str.startsWith("OU")) str = str.slice(2);
      if (str.startsWith("OVER")) return "O";
      if (str.startsWith("UNDER")) return "U";
      if (str === "O" || str.startsWith("O")) return "O";
      if (str === "U" || str.startsWith("U")) return "U";
      return null;
    }
    case "BTTS": {
      str = str.replace(/[^A-Z]/g, "");
      if (str.startsWith("BTTS")) str = str.slice(4);
      if (str.startsWith("BTS")) str = str.slice(3);
      if (!str) return null;
      if (str === "Y" || str === "YES") return "Y";
      if (str === "N" || str === "NO") return "N";
      if (str.includes("YES") || (str.includes("Y") && !str.includes("N"))) return "Y";
      if (str.includes("NO") || (str.includes("N") && !str.includes("Y"))) return "N";
      return null;
    }
    case "HTFT": {
      str = str.replace(/[^A-Z]/g, "");
      if (str.startsWith("HTFT")) str = str.slice(4);
      const letters = str.replace(/[^HAD]/g, "");
      if (letters.length >= 2) {
        const first = letters[0];
        const second = letters[1];
        if ("HAD".includes(first) && "HAD".includes(second)) {
          return `${first}${second}`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export function normalizeMarketPick(rawPick) {
  if (!rawPick || typeof rawPick !== "object") return null;
  const market = normalizeMarket(rawPick.market ?? rawPick.market_code ?? rawPick.marketCode);
  if (!market || !SUPPORTED_MARKETS.has(market)) return null;

  const candidates = [
    rawPick.pick_code,
    rawPick.pickCode,
    rawPick.code,
    rawPick.pick,
    rawPick.selection,
    rawPick.selection_code,
    rawPick.selectionCode,
    rawPick.selection_label,
    rawPick.selectionLabel,
    rawPick.outcome,
    rawPick.outcome_code,
    rawPick.outcomeCode,
  ];

  let rawCode = null;
  for (const cand of candidates) {
    if (cand == null) continue;
    const str = String(cand).trim();
    if (str) {
      rawCode = str;
      break;
    }
  }
  if (!rawCode) return null;

  const pickCode = normalizePickCode(rawCode, market);
  if (!pickCode) return null;

  return { market, pick_code: pickCode };
}

function outcomeCode(diff) {
  if (diff > 0) return "H";
  if (diff < 0) return "A";
  return "D";
}

export function evalPick(pick, scoreRaw, options = {}) {
  const normalizedPick = options && options.normalized ? pick : normalizeMarketPick(pick);
  if (!normalizedPick) return null;
  const score = parseScore(scoreRaw);
  if (!score || !score.ft) return null;

  const { market, pick_code } = normalizedPick;
  const { ft, ht } = score;

  if (market === "1X2") {
    const diff = (ft.home ?? 0) - (ft.away ?? 0);
    if (pick_code === "1") return diff > 0 ? 1 : 0;
    if (pick_code === "X") return diff === 0 ? 1 : 0;
    if (pick_code === "2") return diff < 0 ? 1 : 0;
    return null;
  }

  if (market === "OU2.5") {
    const goals = (ft.home ?? 0) + (ft.away ?? 0);
    if (pick_code === "O") return goals > 2 ? 1 : 0;
    if (pick_code === "U") return goals < 3 ? 1 : 0;
    return null;
  }

  if (market === "BTTS") {
    const yes = (ft.home ?? 0) > 0 && (ft.away ?? 0) > 0;
    if (pick_code === "Y") return yes ? 1 : 0;
    if (pick_code === "N") return !yes ? 1 : 0;
    return null;
  }

  if (market === "HTFT") {
    if (!ht) return null;
    const half = outcomeCode((ht.home ?? 0) - (ht.away ?? 0));
    const full = outcomeCode((ft.home ?? 0) - (ft.away ?? 0));
    if (pick_code === `${half}${full}`) return 1;
    if (pick_code === `${half}-${full}`) return 1;
    return 0;
  }

  return null;
}
