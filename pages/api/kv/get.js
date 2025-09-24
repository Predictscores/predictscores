// pages/api/kv/get.js
// Lightweight KV inspector that never falls through to Next.js 404.

const { kvBackends, readKeyFromBackends } = require("../../../lib/kv-helpers");

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
  try {
    res.setHeader("Cache-Control", "no-store");
    const rawKey = extractKey(req);
    const key = String(rawKey || "").trim();
    if (!key) {
      return res.status(200).json({ ok: true, key: null, hit: false, flavor: null, value: null });
    }

    const backends = kvBackends();
    const read = await readKeyFromBackends(key, { backends });
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
      value: read?.value ?? null,
    };

    if (tried.length) response.tried = tried;

    return res.status(200).json(response);
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
};
