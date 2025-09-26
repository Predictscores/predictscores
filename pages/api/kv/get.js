// pages/api/kv/get.js
// Lightweight KV inspector that never falls through to Next.js 404.

const { kvBackends, readKeyFromBackends } = require("../../../lib/kv-helpers");

function describeType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function interpretRaw(raw) {
  const normalized = raw === undefined ? null : raw;

  if (typeof normalized !== "string") {
    return {
      value: normalized,
      parsed: false,
      parsedType: describeType(normalized),
      error: null,
    };
  }

  const trimmed = normalized.trim();
  if (!trimmed) {
    return {
      value: null,
      parsed: false,
      parsedType: "null",
      error: null,
    };
  }

  try {
    const parsedValue = JSON.parse(trimmed);
    return {
      value: parsedValue,
      parsed: true,
      parsedType: describeType(parsedValue),
      error: null,
    };
  } catch {
    return {
      value: normalized,
      parsed: false,
      parsedType: null,
      error: "invalid_json",
    };
  }
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

module.exports = async function handler(req, res) {
  if (req?.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    res.setHeader("Cache-Control", "no-store");
    const rawKey = extractKey(req);
    const key = String(rawKey || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: "missing_key" });
    }

    const backends = kvBackends();
    const read = await readKeyFromBackends(key, { backends, parseJson: false });
    const rawValue = read?.value === undefined ? null : read.value;
    const { value, parsed, parsedType, error } = interpretRaw(rawValue);
    const tried = Array.isArray(read?.tried)
      ? read.tried.map((attempt) => ({
          flavor: attempt?.flavor || "unknown",
          ok: Boolean(attempt?.ok),
          hit: Boolean(attempt?.hit),
          count: Number(attempt?.count || 0),
        }))
      : [];

    const response = {
      ok: true,
      key,
      hit: Boolean(read?.hit),
      flavor: read?.flavor || null,
      raw: rawValue,
      value,
      valueType: describeType(rawValue),
      parsed,
      parsedType,
    };

    if (!parsed && error) {
      response.parseError = error;
    }

    if (tried.length) response.tried = tried;

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
};
