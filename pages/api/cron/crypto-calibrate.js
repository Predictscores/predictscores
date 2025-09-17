// pages/api/cron/crypto-calibrate.js
// Offline kalibracija confidenceFrom: agregira realizovane ishode i optimizuje težine/skale.

import { defaultConfidenceConfig } from "../../../lib/crypto-core";

const {
  UPSTASH_REDIS_REST_URL = "",
  UPSTASH_REDIS_REST_TOKEN = "",
  CRON_KEY = "",
  CRYPTO_OUTCOME_LOG_KEY = "crypto:outcomes:log",
  CRYPTO_CONFIDENCE_KV_KEY = "crypto:confidence:calib",
  CRYPTO_CONFIDENCE_CALIB_MIN = "120",
  CRYPTO_CONFIDENCE_CALIB_MAX = "2000",
  CRYPTO_CONFIDENCE_CALIB_TTL_DAYS = "90",
} = process.env;

const TF_LIST = ["m30", "h1", "h4", "d24", "d7"];

export default async function handler(req, res) {
  try {
    if (!checkCronKey(req, CRON_KEY)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const minSamples = clampInt(req.query?.min || CRYPTO_CONFIDENCE_CALIB_MIN, 120, 10, 1000);
    const maxSamples = clampInt(req.query?.max || CRYPTO_CONFIDENCE_CALIB_MAX, 1500, minSamples, 5000);

    const rawEntries = await kvListRange(CRYPTO_OUTCOME_LOG_KEY, 0, maxSamples - 1);
    const parsed = dedupeEntries(rawEntries);
    const { samples, stats, confidence: confStats, buckets } = prepareSamples(parsed);

    if (samples.length < minSamples) {
      return res.status(200).json({
        ok: false,
        error: "not_enough_samples",
        sample_count: samples.length,
        min_required: minSamples,
        stats,
        confidence: confStats,
        buckets,
      });
    }

    const defaults = defaultConfidenceConfig();
    const optim = optimizeConfidence(samples, defaults);
    const evalSummary = evaluateModel(samples, optim.weights, optim.scales);

    const payload = {
      ts: Date.now(),
      sample_count: samples.length,
      weights: optim.weights,
      scales: optim.scales,
      loss: optim.loss,
      evaluation: evalSummary,
      stats,
      confidence: confStats,
      buckets,
      defaults,
    };
    const ttl = clampInt(CRYPTO_CONFIDENCE_CALIB_TTL_DAYS, 90, 1, 365) * 86400;
    await kvSetJSON(CRYPTO_CONFIDENCE_KV_KEY, payload, ttl);

    return res.status(200).json({
      ok: true,
      saved: true,
      sample_count: samples.length,
      weights: optim.weights,
      scales: optim.scales,
      loss: optim.loss,
      evaluation: evalSummary,
      stats,
      confidence: confStats,
      buckets,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

function dedupeEntries(rawEntries) {
  const out = [];
  const seen = new Set();
  for (const row of rawEntries) {
    let obj = null;
    try {
      obj = typeof row === "string" ? JSON.parse(row) : row;
    } catch {
      obj = null;
    }
    if (!obj || typeof obj !== "object") continue;
    const id = String(obj.id || `${obj.symbol || ""}:${obj.ts || 0}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(obj);
  }
  return out;
}

function prepareSamples(entries) {
  const stats = initStats();
  const confStats = initConfidenceStats();
  const buckets = initConfidenceBuckets();
  const samples = [];

  for (const entry of entries) {
    const side = String(entry.side || entry.signal || "").toUpperCase();
    if (side !== "LONG" && side !== "SHORT") continue;
    const dir = side === "LONG" ? 1 : -1;
    const win = typeof entry.win === "number" ? (entry.win > 0 ? 1 : (entry.win === 0 ? 0 : null)) : null;

    const sample = {
      id: entry.id,
      side,
      dir,
      target: win == null ? null : (win === 1 ? 1 : -1),
      features: {},
      raw: {},
      confidence: numOrNull(entry.confidence_pct),
    };

    let hasFeature = false;
    for (const tf of TF_LIST) {
      const key = `${tf}_pct`;
      const rawVal = numOrNull(entry[key]);
      if (rawVal == null) {
        sample.features[tf] = 0;
        sample.raw[tf] = null;
      } else {
        sample.features[tf] = dir * rawVal;
        sample.raw[tf] = rawVal;
        hasFeature = true;
      }
    }
    if (!hasFeature) continue;

    updateStats(stats, sample);
    updateConfidenceStats(confStats, sample);
    updateBuckets(buckets, sample, win);

    if (sample.target != null) {
      samples.push(sample);
    }
  }

  return {
    samples,
    stats: finalizeStats(stats),
    confidence: finalizeConfidenceStats(confStats),
    buckets: finalizeBuckets(buckets),
  };
}

function initStats() {
  const stats = {};
  for (const tf of TF_LIST) {
    stats[tf] = {
      LONG: { count: 0, wins: 0, sum: 0, sumDir: 0, sumAbs: 0 },
      SHORT: { count: 0, wins: 0, sum: 0, sumDir: 0, sumAbs: 0 },
      overall: { count: 0, wins: 0, sum: 0, sumDir: 0, sumAbs: 0 },
    };
  }
  return stats;
}

function updateStats(stats, sample) {
  for (const tf of TF_LIST) {
    const raw = sample.raw[tf];
    if (raw == null) continue;
    const feat = sample.features[tf];
    const sideStats = stats[tf][sample.side];
    const overall = stats[tf].overall;

    sideStats.count += 1;
    sideStats.sum += raw;
    sideStats.sumDir += feat;
    sideStats.sumAbs += Math.abs(raw);
    if (sample.target === 1) sideStats.wins += 1;

    overall.count += 1;
    overall.sum += raw;
    overall.sumDir += feat;
    overall.sumAbs += Math.abs(raw);
    if (sample.target === 1) overall.wins += 1;
  }
}

function finalizeStats(stats) {
  const out = {};
  for (const tf of TF_LIST) {
    const node = stats[tf];
    out[tf] = {
      long: summarizeNode(node.LONG),
      short: summarizeNode(node.SHORT),
      overall: summarizeNode(node.overall),
    };
  }
  return out;
}

function summarizeNode(node) {
  if (!node.count) {
    return { count: 0, win_rate: null, avg_delta: null, avg_signed_delta: null, avg_abs_delta: null };
  }
  return {
    count: node.count,
    win_rate: node.count ? node.wins / node.count : null,
    avg_delta: node.sum / node.count,
    avg_signed_delta: node.sumDir / node.count,
    avg_abs_delta: node.sumAbs / node.count,
  };
}

function initConfidenceStats() {
  return {
    all: { sum: 0, count: 0 },
    wins: { sum: 0, count: 0 },
    losses: { sum: 0, count: 0 },
  };
}

function updateConfidenceStats(confStats, sample) {
  const c = numOrNull(sample.confidence);
  if (c == null) return;
  confStats.all.sum += c;
  confStats.all.count += 1;
  if (sample.target === 1) {
    confStats.wins.sum += c;
    confStats.wins.count += 1;
  } else if (sample.target === -1) {
    confStats.losses.sum += c;
    confStats.losses.count += 1;
  }
}

function finalizeConfidenceStats(confStats) {
  const avg = (node) => (node.count ? node.sum / node.count : null);
  return {
    mean_confidence: avg(confStats.all),
    mean_confidence_win: avg(confStats.wins),
    mean_confidence_loss: avg(confStats.losses),
  };
}

function initConfidenceBuckets() {
  return [
    { min: 0, max: 64, wins: 0, losses: 0 },
    { min: 65, max: 74, wins: 0, losses: 0 },
    { min: 75, max: 84, wins: 0, losses: 0 },
    { min: 85, max: 94, wins: 0, losses: 0 },
    { min: 95, max: 101, wins: 0, losses: 0 },
  ];
}

function updateBuckets(buckets, sample, win) {
  const c = numOrNull(sample.confidence);
  if (c == null || win == null) return;
  for (const bucket of buckets) {
    if (c >= bucket.min && c <= bucket.max) {
      if (win === 1) bucket.wins += 1;
      else bucket.losses += 1;
      break;
    }
  }
}

function finalizeBuckets(buckets) {
  return buckets.map((b) => {
    const total = b.wins + b.losses;
    return {
      range: [b.min, b.max],
      count: total,
      win_rate: total ? b.wins / total : null,
    };
  });
}

function optimizeConfidence(samples, defaults) {
  const weights = { ...defaults.weights };
  const scales = { ...defaults.scales };
  let best = { weights: { ...weights }, scales: { ...scales }, loss: Number.POSITIVE_INFINITY };
  let prevLoss = Number.POSITIVE_INFINITY;
  const lrW = 0.12;
  const lrS = 0.06;
  const maxIter = 160;

  for (let iter = 0; iter < maxIter; iter++) {
    const gradW = initZeroVector();
    const gradS = initZeroVector();
    let loss = 0;

    for (const sample of samples) {
      const { score, tanhs } = forward(weights, scales, sample.features);
      const err = score - sample.target;
      loss += err * err;

      for (const tf of TF_LIST) {
        gradW[tf] += 2 * err * tanhs[tf];
        const feat = sample.features[tf] || 0;
        if (feat === 0) continue;
        const scale = scales[tf];
        if (!Number.isFinite(scale) || scale === 0) continue;
        const sech2 = 1 - tanhs[tf] * tanhs[tf];
        gradS[tf] += 2 * err * (weights[tf] || 0) * sech2 * (-feat / (scale * scale));
      }
    }

    const n = samples.length || 1;
    loss /= n;

    for (const tf of TF_LIST) {
      const step = (lrW * gradW[tf]) / n;
      weights[tf] = clamp(weights[tf] - step, 0, 1);
    }
    normalizeWeights(weights, defaults.weights);

    for (const tf of TF_LIST) {
      const step = (lrS * gradS[tf]) / n;
      const next = scales[tf] - step;
      scales[tf] = clamp(next, 0.2, 10);
    }

    if (loss < best.loss - 1e-6) {
      best = { weights: { ...weights }, scales: { ...scales }, loss };
    }
    if (Math.abs(prevLoss - loss) < 1e-5) break;
    prevLoss = loss;
  }

  return best;
}

function forward(weights, scales, features) {
  const tanhs = {};
  let score = 0;
  for (const tf of TF_LIST) {
    const scale = scales[tf] || 1;
    const feat = features[tf] || 0;
    const x = scale > 0 ? feat / scale : feat;
    const t = Math.tanh(x);
    tanhs[tf] = t;
    score += (weights[tf] || 0) * t;
  }
  return { score, tanhs };
}

function initZeroVector() {
  const obj = {};
  for (const tf of TF_LIST) obj[tf] = 0;
  return obj;
}

function normalizeWeights(weights, fallback) {
  let sum = 0;
  for (const tf of TF_LIST) {
    const val = Number(weights[tf]);
    if (!Number.isFinite(val) || val < 0) {
      weights[tf] = Number(fallback?.[tf]) || 0;
    }
    sum += weights[tf];
  }
  if (sum <= 0) {
    for (const tf of TF_LIST) {
      weights[tf] = Number(fallback?.[tf]) || 0;
      sum += weights[tf];
    }
  }
  if (sum > 0) {
    for (const tf of TF_LIST) weights[tf] = weights[tf] / sum;
  }
}

function evaluateModel(samples, weights, scales) {
  if (!samples.length) return { mse: null, accuracy: null, mean_abs_error: null };
  let mse = 0;
  let mae = 0;
  let correct = 0;
  for (const sample of samples) {
    const { score } = forward(weights, scales, sample.features);
    const err = score - sample.target;
    mse += err * err;
    mae += Math.abs(err);
    const predicted = score >= 0 ? 1 : -1;
    if (predicted === sample.target) correct += 1;
  }
  const n = samples.length;
  return {
    mse: mse / n,
    mean_abs_error: mae / n,
    accuracy: correct / n,
  };
}

async function kvListRange(key, start, stop) {
  if (!UPSTASH_REDIS_REST_URL || !key) return [];
  try {
    const base = UPSTASH_REDIS_REST_URL.replace(/\/+$/, "");
    const u = `${base}/lrange/${encodeURIComponent(key)}/${start}/${stop}`;
    const r = await fetch(u, { headers: authHeader(), cache: "no-store" });
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    const arr = Array.isArray(j?.result) ? j.result : [];
    return arr;
  } catch {
    return [];
  }
}

async function kvSetJSON(key, value, ttlSec) {
  if (!UPSTASH_REDIS_REST_URL || !key) return;
  const base = UPSTASH_REDIS_REST_URL.replace(/\/+$/, "");
  const payload = encodeURIComponent(JSON.stringify(value));
  const url = new URL(`${base}/set/${encodeURIComponent(key)}/${payload}`);
  if (ttlSec && ttlSec > 0) url.searchParams.set("EX", String(ttlSec));
  await fetch(url.toString(), { headers: authHeader(), cache: "no-store" }).catch(() => {});
}

function authHeader() {
  const h = {};
  if (UPSTASH_REDIS_REST_TOKEN) h["Authorization"] = `Bearer ${UPSTASH_REDIS_REST_TOKEN}`;
  return h;
}

function checkCronKey(req, expected) {
  if (!expected) return false;
  const q = String(req.query.key || "");
  const h = String(req.headers["x-cron-key"] || "");
  const auth = String(req.headers["authorization"] || "");
  if (q && q === expected) return true;
  if (h && h === expected) return true;
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7) === expected) return true;
  return false;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
