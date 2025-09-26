// pages/api/kv/get.js
// Lightweight KV inspector that never falls through to Next.js 404.

const {
  kvBackends,
  readKeyFromBackends,
  KvEnvMisconfigurationError,
  PRODUCTION_MISCONFIG_CODE,
} = require("../../../lib/kv-helpers");

function respondWithProductionMisconfig(res, err) {
  return res.status(500).json({
    ok: false,
    error: "Confirm env vars present in Production",
    name: err?.name || "KvEnvMisconfigurationError",
    code: PRODUCTION_MISCONFIG_CODE,
  });
}

function isProductionMisconfig(error) {
  if (!error) return false;
  if (error instanceof KvEnvMisconfigurationError) return true;
  return String(error?.code || "") === PRODUCTION_MISCONFIG_CODE;
}

function extractKey(req) {
  if (req?.query?.key != null) {
    const raw = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
    return raw != null ? String(raw) : "";
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const value = url.searchParams.get("key");
    return value != null ? String(value) : "";
  } catch {
    return "";
  }
}

const KEY_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]*:/i;

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    res.setHeader("Cache-Control", "no-store");
    const rawKey = extractKey(req);
    const key = String(rawKey || "").trim();

    if (!key) {
      return res.status(400).json({ ok: false, error: "Missing 'key' query parameter" });
    }

    if (!KEY_PREFIX_PATTERN.test(key)) {
      return res.status(400).json({ ok: false, key, error: "Invalid key prefix" });
    }

    let backends;
    try {
      backends = kvBackends();
    } catch (err) {
      if (isProductionMisconfig(err)) {
        return respondWithProductionMisconfig(res, err);
      }
      throw err;
    }
    let read;

    try {
      read = await readKeyFromBackends(key, { backends, parseJson: false });
    } catch (error) {
      if (isProductionMisconfig(error)) {
        return respondWithProductionMisconfig(res, error);
      }
      return res.status(500).json({
        ok: false,
        error: error?.message || String(error),
        name: error?.name || null,
        code: error?.code || null,
      });
    }

    const tried = Array.isArray(read?.tried)
      ? read.tried.map((attempt) => ({
          flavor: attempt?.flavor || "unknown",
          ok: Boolean(attempt?.ok),
          hit: Boolean(attempt?.hit),
          count: Number(attempt?.count || 0),
        }))
      : [];

    const raw = typeof read?.value === "undefined" ? null : read?.value;
    const valueType = raw === null ? "null" : typeof raw;
    let parsed = null;
    let parsedType = null;

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) {
        try {
          parsed = JSON.parse(trimmed);
          parsedType = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
        } catch {
          parsed = null;
          parsedType = null;
        }
      }
    }

    const response = {
      ok: true,
      key,
      hit: Boolean(read?.hit),
      flavor: read?.flavor || null,
      valueType,
      parsedType,
      raw,
      parsed,
    };

    if (tried.length) response.tried = tried;

    return res.status(200).json(response);
  } catch (err) {
    if (isProductionMisconfig(err)) {
      return respondWithProductionMisconfig(res, err);
    }
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      name: err?.name || null,
      code: err?.code || null,
    });
  }
};
