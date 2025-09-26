const clamp = (value, lo, hi) => {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
};

const clamp01 = (value) => {
  if (!Number.isFinite(value)) return 0;
  return clamp(value, 0, 1);
};

const DEFAULT_FLAGS = {
  enable_calib: false,
  enable_evmin: false,
  enable_league_adj: false,
  shadow_mode: true,
};

function normalizeFlags(raw) {
  const out = { ...DEFAULT_FLAGS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    if (typeof raw[key] === "boolean") out[key] = raw[key];
  }
  if (typeof raw.shadow_mode !== "boolean") out.shadow_mode = true;
  return out;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractSamples(doc) {
  if (!doc || typeof doc !== "object") return 0;
  const candidates = [
    doc.samples,
    doc.sample_size,
    doc.sampleSize,
    doc.n,
    doc.count,
    doc.total,
    doc.size,
  ];
  for (const cand of candidates) {
    const num = toFiniteNumber(cand);
    if (num != null && num >= 0) return num;
  }
  return 0;
}

function safeRegex(src, fallback) {
  if (typeof src !== "string" || !src) return fallback;
  try {
    return new RegExp(src, "i");
  } catch {
    return fallback;
  }
}

const DEFAULT_TIER1_RE = /(Premier\s+League|La\s+Liga|Serie\s+A|Bundesliga|Ligue\s+1|Champions\s+League|UEFA\s*Champ)/i;
const DEFAULT_TIER2_RE = /(Championship|Eredivisie|Primeira|Liga\s+Portugal|Super\s+Lig|Pro\s+League|Bundesliga\s+2|Serie\s+B|LaLiga\s+2|Ligue\s+2|Eerste\s+Divisie)/i;

const TIER1_IDS = new Set([39, 40, 61, 78, 135, 140, 2, 3, 848, 848]);
const TIER2_IDS = new Set([41, 42, 88, 94, 95, 96, 99, 103, 144, 208, 210]);

function normalizeTierLabel(value) {
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (!upper) return null;
    if (upper === "T1" || upper === "TIER1" || upper === "1") return "T1";
    if (upper === "T2" || upper === "TIER2" || upper === "2") return "T2";
    if (upper === "T3" || upper === "TIER3" || upper === "3") return "T3";
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 1) return "T1";
    if (value <= 2) return "T2";
    return "T3";
  }
  if (value && typeof value === "object") {
    if (typeof value.tier === "string") return normalizeTierLabel(value.tier);
    if (typeof value.value === "string") return normalizeTierLabel(value.value);
  }
  return null;
}

function buildTierIdSet(baseSet, extra) {
  const out = new Set(baseSet);
  const append = (val) => {
    const num = toFiniteNumber(val);
    if (num != null) out.add(num);
  };
  if (Array.isArray(extra)) {
    for (const val of extra) append(val);
  }
  return out;
}

function pickTierOverride(overrides, league) {
  if (!overrides || typeof overrides !== "object" || !league || typeof league !== "object") {
    return null;
  }

  const allOverrides = overrides instanceof Map ? overrides : null;
  if (allOverrides) {
    const id = toFiniteNumber(league.id || league.league_id || league.leagueId);
    if (id != null && allOverrides.has(`id:${id}`)) return normalizeTierLabel(allOverrides.get(`id:${id}`));
    if (id != null && allOverrides.has(String(id))) return normalizeTierLabel(allOverrides.get(String(id)));

    const nameCandidates = [
      league.name,
      league.league_name,
      league.league?.name,
      league.slug,
      league.code,
    ];
    for (const cand of nameCandidates) {
      if (typeof cand !== "string") continue;
      const key = cand.trim().toLowerCase();
      if (!key) continue;
      if (allOverrides.has(key)) return normalizeTierLabel(allOverrides.get(key));
      if (allOverrides.has(`name:${key}`)) return normalizeTierLabel(allOverrides.get(`name:${key}`));
    }
    return null;
  }

  const lookup = {};
  const assign = (rawKey, rawVal) => {
    const tier = normalizeTierLabel(rawVal);
    if (!tier) return;
    const key = typeof rawKey === "string" ? rawKey.trim().toLowerCase() : String(rawKey || "").trim().toLowerCase();
    if (!key) return;
    lookup[key] = tier;
  };

  if (Array.isArray(overrides)) {
    for (const entry of overrides) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.id != null) assign(entry.id, entry.tier ?? entry.value ?? entry.level ?? entry.tier_level);
      if (entry.key != null) assign(entry.key, entry.tier ?? entry.value ?? entry.level ?? entry.tier_level);
      if (entry.name) assign(entry.name, entry.tier ?? entry.value ?? entry.level ?? entry.tier_level);
    }
  } else {
    for (const [rawKey, rawVal] of Object.entries(overrides)) {
      if (rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
        assign(rawKey, rawVal.tier ?? rawVal.value ?? rawVal.level ?? rawVal.tier_level);
      } else {
        assign(rawKey, rawVal);
      }
    }
  }

  const id = toFiniteNumber(league.id || league.league_id || league.leagueId);
  if (id != null) {
    const idKey = String(id);
    if (lookup[idKey]) return lookup[idKey];
    if (lookup[`id:${idKey}`]) return lookup[`id:${idKey}`];
  }

  const nameCandidates = [
    league.name,
    league.league_name,
    league.league?.name,
    league.slug,
    league.code,
  ];
  for (const cand of nameCandidates) {
    if (typeof cand !== "string") continue;
    const key = cand.trim().toLowerCase();
    if (!key) continue;
    if (lookup[key]) return lookup[key];
    if (lookup[`name:${key}`]) return lookup[`name:${key}`];
  }

  return null;
}

function resolveLeagueTier(league, env = {}) {
  if (!league || typeof league !== "object") return "T3";

  const tierOverride = pickTierOverride(env.tier_overrides, league) || pickTierOverride(env.overrides, league);
  if (tierOverride) return tierOverride;

  const tierRaw = [league.tier, league.tier_level, league.level, league.rank, league.ranking];
  for (const cand of tierRaw) {
    const num = toFiniteNumber(cand);
    if (num == null) continue;
    if (num <= 1) return "T1";
    if (num <= 2) return "T2";
    return "T3";
  }

  const id = toFiniteNumber(league.id || league.league_id || league.leagueId);
  if (id != null) {
    const tier1Ids = buildTierIdSet(TIER1_IDS, env.tier1_ids || env.tier1Ids);
    const tier2Ids = buildTierIdSet(TIER2_IDS, env.tier2_ids || env.tier2Ids);
    if (tier1Ids.has(id)) return "T1";
    if (tier2Ids.has(id)) return "T2";
  }

  const name = String(league.name || league.league_name || "").trim();
  if (name) {
    const tier1Re = safeRegex(env.TIER1_RE ?? env.tier1_re, DEFAULT_TIER1_RE);
    const tier2Re = safeRegex(env.TIER2_RE ?? env.tier2_re, DEFAULT_TIER2_RE);
    if (tier1Re.test(name)) return "T1";
    if (tier2Re.test(name)) return "T2";
  }

  return "T3";
}

function resolveMarketBucket(rawMarket) {
  const market = String(rawMarket || "").toUpperCase();
  if (!market) return "UNK";
  if (market === "BTTS") return "BTTS";
  if (market === "OU2.5" || market === "OU25" || market === "O/U 2.5") return "OU2.5";
  if (market === "FH_OU1.5" || market === "FH OU1.5" || market === "FH-OU1.5") return "FH_OU1.5";
  if (market === "HTFT" || market === "HT/FT" || market === "HT-FT") return "HTFT";
  if (market === "1X2" || market === "1X-2" || market === "H2H") return "1X2";
  return market;
}

function resolveOddsBand(price) {
  const num = toFiniteNumber(price);
  if (num == null || num <= 0) return "UNK";
  if (num <= 1.75) return "1.50-1.75";
  if (num <= 2.20) return "1.76-2.20";
  return "2.21+";
}

function logisticAdjust(prob, intercept, slope) {
  const slopeNum = toFiniteNumber(slope);
  const interceptNum = toFiniteNumber(intercept);
  if (slopeNum == null || interceptNum == null) return null;
  const eps = 1e-5;
  const p = clamp(prob, eps, 1 - eps);
  const logit = Math.log(p / (1 - p));
  const z = interceptNum + slopeNum * logit;
  const out = 1 / (1 + Math.exp(-z));
  return Number.isFinite(out) ? clamp01(out) : null;
}

function isotonicAdjust(prob, points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const pairs = points
    .map((p) => {
      if (Array.isArray(p) && p.length >= 2) {
        return { x: toFiniteNumber(p[0]), y: toFiniteNumber(p[1]) };
      }
      if (p && typeof p === "object") {
        return { x: toFiniteNumber(p.x ?? p[0]), y: toFiniteNumber(p.y ?? p[1]) };
      }
      return { x: null, y: null };
    })
    .filter((p) => p.x != null && p.y != null)
    .sort((a, b) => a.x - b.x);
  if (!pairs.length) return null;
  const lo = pairs[0];
  const hi = pairs[pairs.length - 1];
  const clamped = clamp(prob, lo.x, hi.x);
  for (let i = 0; i < pairs.length - 1; i += 1) {
    const a = pairs[i];
    const b = pairs[i + 1];
    if (clamped >= a.x && clamped <= b.x) {
      const span = b.x - a.x;
      if (span <= 1e-6) return clamp01((a.y + b.y) / 2);
      const t = (clamped - a.x) / span;
      return clamp01(a.y * (1 - t) + b.y * t);
    }
  }
  return clamp01(hi.y);
}

function deltaAdjust(prob, doc) {
  const deltaCandidates = [
    doc.delta_pp,
    doc.deltaPct,
    doc.delta_ppc,
    doc.delta,
    doc.adjustment_pp,
    doc.adjustment,
    doc.bias_pp,
    doc.shift_pp,
    doc.prob_delta_pp,
  ];
  for (const cand of deltaCandidates) {
    const num = toFiniteNumber(cand);
    if (num != null) {
      const final = clamp01(prob + num / 100);
      return final;
    }
  }
  const fractionalCandidates = [doc.delta_prob, doc.delta_probability, doc.prob_delta, doc.bias];
  for (const cand of fractionalCandidates) {
    const num = toFiniteNumber(cand);
    if (num != null) {
      return clamp01(prob + num);
    }
  }
  return null;
}

function applyCalibration(prob, doc) {
  const base = { prob, applied: false, samples: extractSamples(doc), method: null };
  if (!Number.isFinite(prob) || !doc || typeof doc !== "object") return base;
  const samples = base.samples;
  if (samples < 200) return base;

  const type = String(doc.type || "").toLowerCase();
  let adjusted = null;
  if (type === "logistic" || (toFiniteNumber(doc.intercept) != null && toFiniteNumber(doc.slope) != null)) {
    adjusted = logisticAdjust(prob, doc.intercept ?? doc.alpha ?? doc.a ?? doc.bias, doc.slope ?? doc.beta ?? doc.b);
    base.method = "logistic";
  }
  if (adjusted == null) {
    const coef = Array.isArray(doc.coef) ? doc.coef : Array.isArray(doc.coeff) ? doc.coeff : null;
    if (coef && coef.length >= 2) {
      adjusted = logisticAdjust(prob, coef[0], coef[1]);
      base.method = "logistic";
    }
  }
  if (adjusted == null && Array.isArray(doc.coefficients) && doc.coefficients.length >= 2) {
    adjusted = logisticAdjust(prob, doc.coefficients[0], doc.coefficients[1]);
    base.method = "logistic";
  }
  if (adjusted == null && (type === "isotonic" || Array.isArray(doc.points))) {
    adjusted = isotonicAdjust(prob, doc.points || doc.table || doc.pairs);
    base.method = "isotonic";
  }
  if (adjusted == null && Array.isArray(doc.calibration)) {
    adjusted = isotonicAdjust(prob, doc.calibration);
    base.method = "isotonic";
  }
  if (adjusted == null) {
    adjusted = deltaAdjust(prob, doc);
    if (adjusted != null) base.method = "delta";
  }

  if (adjusted == null || !Number.isFinite(adjusted)) return base;

  const diff = clamp(adjusted - prob, -0.07, 0.07);
  const finalProb = clamp01(prob + diff);
  return { prob: finalProb, applied: Math.abs(diff) >= 1e-6, samples, method: base.method };
}

function parseLeagueDelta(doc) {
  const rawCandidates = [
    doc.delta_pp,
    doc.adjustment_pp,
    doc.bias_pp,
    doc.deltaPct,
    doc.pp,
    doc.prob_delta_pp,
  ];
  for (const cand of rawCandidates) {
    const num = toFiniteNumber(cand);
    if (num != null) return num;
  }
  const fractionalCandidates = [doc.delta, doc.adjustment, doc.bias, doc.prob_delta, doc.delta_prob];
  for (const cand of fractionalCandidates) {
    const num = toFiniteNumber(cand);
    if (num != null) return num * 100;
  }
  return null;
}

function applyLeagueAdjustment(prob, doc) {
  const base = { prob, applied: false, samples: extractSamples(doc), delta_pp: 0 };
  if (!Number.isFinite(prob) || !doc || typeof doc !== "object") return base;
  const samples = base.samples;
  if (samples < 200) return base;
  const delta = parseLeagueDelta(doc);
  if (delta == null) return base;
  const clampedDelta = clamp(delta, -3, 3);
  const finalProb = clamp01(prob + clampedDelta / 100);
  return { prob: finalProb, applied: Math.abs(clampedDelta) > 1e-6, samples, delta_pp: clampedDelta };
}

const DEFAULT_EV_MIN_PP = {
  BTTS: 2.0,
  "OU2.5": 2.0,
  "FH_OU1.5": 2.0,
  HTFT: 2.5,
  "1X2": 1.5,
};

function resolveDefaultEvGuard(marketBucket) {
  return DEFAULT_EV_MIN_PP[marketBucket] ?? 2.0;
}

function parseEvDoc(doc) {
  if (!doc || typeof doc !== "object") return { value_pp: null, samples: 0 };
  const samples = extractSamples(doc);
  const ppCandidates = [
    doc.ev_min_pp,
    doc.ev_pp,
    doc.ev_pp_min,
    doc.edge_min_pp,
    doc.pp,
  ];
  for (const cand of ppCandidates) {
    const num = toFiniteNumber(cand);
    if (num != null) return { value_pp: num, samples };
  }
  const fracCandidates = [doc.ev_min, doc.ev, doc.threshold];
  for (const cand of fracCandidates) {
    const num = toFiniteNumber(cand);
    if (num != null) return { value_pp: num * 100, samples };
  }
  return { value_pp: null, samples };
}

function applyEvGuard(defaultGuard, doc) {
  const base = { guard_pp: clamp(defaultGuard, 0.5, 8), applied: false, samples: 0 };
  const parsed = parseEvDoc(doc);
  const samples = parsed.samples;
  base.samples = samples;
  if (samples < 200) return base;
  const learned = parsed.value_pp;
  if (!Number.isFinite(learned)) return base;
  const clamped = clamp(learned, 0.5, 8);
  const guard = Math.max(base.guard_pp, clamped);
  return { guard_pp: guard, applied: guard > base.guard_pp + 1e-6, samples };
}

module.exports = {
  DEFAULT_FLAGS,
  normalizeFlags,
  resolveLeagueTier,
  resolveMarketBucket,
  resolveOddsBand,
  applyCalibration,
  applyLeagueAdjustment,
  applyEvGuard,
  resolveDefaultEvGuard,
  extractSamples,
};
