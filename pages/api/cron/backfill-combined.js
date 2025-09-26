// pages/api/cron/backfill-combined.js
// Backfills vb:day:<YMD>:combined from vb:day:<YMD>:union.

const {
  kvBackends,
  readKeyFromBackends,
  saveCombinedAlias,
  KvEnvMisconfigurationError,
  PRODUCTION_MISCONFIG_CODE,
} = require("../../../lib/kv-helpers");

function isProductionMisconfig(error) {
  if (!error) return false;
  if (error instanceof KvEnvMisconfigurationError) return true;
  return String(error?.code || "") === PRODUCTION_MISCONFIG_CODE;
}

function respondWithProductionMisconfig(res, err) {
  return res.status(500).json({
    ok: false,
    error: "Confirm env vars present in Production",
    name: err?.name || "KvEnvMisconfigurationError",
    code: PRODUCTION_MISCONFIG_CODE,
  });
}

function summarizeCounts(key, read, backends) {
  const summary = {};
  const flavors = new Set();
  for (const backend of backends || []) {
    if (backend?.flavor) flavors.add(backend.flavor);
  }
  if (Array.isArray(read?.tried)) {
    for (const attempt of read.tried) {
      const flavor = attempt?.flavor || "unknown";
      flavors.add(flavor);
    }
  } else if (read?.flavor) {
    flavors.add(read.flavor);
  }
  if (!flavors.size) flavors.add("default");
  for (const flavor of flavors) {
    summary[flavor] = 0;
  }
  if (Array.isArray(read?.tried)) {
    for (const attempt of read.tried) {
      const flavor = attempt?.flavor || "unknown";
      const count = Number(attempt?.count || 0);
      summary[flavor] = count;
    }
  } else if (read?.flavor) {
    summary[read.flavor] = Number(read.count || 0);
  }
  return summary;
}

function pickUnionPayload(read) {
  if (!read) return { value: null, flavor: null };
  const tried = Array.isArray(read.tried) ? read.tried : [];
  const preferredOrder = ["vercel-kv", "upstash-redis"];
  for (const flavor of preferredOrder) {
    const match = tried.find((attempt) => attempt?.flavor === flavor && Number(attempt?.count || 0) > 0 && attempt.value != null);
    if (match) return { value: match.value, flavor };
  }
  if (read.value != null && Number(read.count || 0) > 0) {
    return { value: read.value, flavor: read.flavor || null };
  }
  const fallback = tried.find((attempt) => attempt?.value != null && Number(attempt?.count || 0) > 0);
  if (fallback) {
    return { value: fallback.value, flavor: fallback.flavor || null };
  }
  return { value: null, flavor: null };
}

module.exports = async function handler(req, res) {
  try {
    const cronKey = String(process.env.CRON_KEY || "").trim();
    const providedKey = String(req.query?.key || req.body?.key || "").trim();
    if (!cronKey || !providedKey || providedKey !== cronKey) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const ymd = String(req.query?.ymd || req.body?.ymd || "").trim();
    if (!ymd) {
      return res.status(400).json({ ok: false, error: "missing_ymd" });
    }

    const debugMode = String(req.query?.debug || req.body?.debug || "") === "1";
    const trace = [];
    let backends;
    try {
      backends = kvBackends();
    } catch (err) {
      if (isProductionMisconfig(err)) {
        return respondWithProductionMisconfig(res, err);
      }
      throw err;
    }

    const combinedKey = `vb:day:${ymd}:combined`;
    const unionKey = `vb:day:${ymd}:union`;

    const combinedRead = await readKeyFromBackends(combinedKey, { backends, trace });
    const unionRead = await readKeyFromBackends(unionKey, { backends, trace });

    const perKeyCounts = {
      [combinedKey]: summarizeCounts(combinedKey, combinedRead, backends),
      [unionKey]: summarizeCounts(unionKey, unionRead, backends),
    };

    let wrote = false;
    let sourceFlavor = null;

    if (Number(combinedRead?.count || 0) <= 0) {
      const { value: unionPayload, flavor: unionFlavor } = pickUnionPayload(unionRead);
      sourceFlavor = unionFlavor;
      if (unionPayload != null) {
        const result = await saveCombinedAlias({
          ymd,
          payload: unionPayload,
          from: unionFlavor || "union",
          trace,
        });
        wrote = Boolean(result?.count > 0 && result?.wrote);
        if (wrote) {
          const refreshed = await readKeyFromBackends(combinedKey, { backends, trace });
          perKeyCounts[combinedKey] = summarizeCounts(combinedKey, refreshed, backends);
        }
      }
    }

    const response = {
      ok: true,
      ymd,
      wrote,
      perKeyCounts,
    };

    if (debugMode) {
      response.debug = { trace, sourceFlavor: sourceFlavor || null };
    }

    return res.status(200).json(response);
  } catch (err) {
    if (isProductionMisconfig(err)) {
      return respondWithProductionMisconfig(res, err);
    }
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
