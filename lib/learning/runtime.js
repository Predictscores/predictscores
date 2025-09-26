const { matchLeagueTier } = require("../leaguesConfig");

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

function resolveLeagueTier(league, env = {}) {
  if (!league || typeof league !== "object") return "T3";

  const tierRaw = [league.tier, league.tier_level, league.level, league.rank, league.ranking];
  for (const cand of tierRaw) {
    const num = toFiniteNumber(cand);
    if (num == null) continue;
    if (num <= 1) return "T1";
    if (num <= 2) return "T2";
    return "T3";
  }

  const overrides = {};
  const envTier1 = safeRegex(env.TIER1_RE ?? process.env?.TIER1_RE, null);
  const envTier2 = safeRegex(env.TIER2_RE ?? process.env?.TIER2_RE, null);
  if (envTier1) overrides.T1 = [envTier1];
  if (envTier2) overrides.T2 = [envTier2];

  const matched = matchLeagueTier(league, { regexOverrides: overrides });
  return matched || "T3";
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
