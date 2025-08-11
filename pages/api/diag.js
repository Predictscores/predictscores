// FILE: pages/api/diag.js
export default async function handler(req, res) {
  const headers = req.headers || {};
  const proto = headers["x-forwarded-proto"] || "http";
  const host = headers["x-forwarded-host"] || headers.host;
  const base = `${proto}://${host}`;

  const has = (k) => !!(process.env[k] && String(process.env[k]).trim() !== "");

  // in-memory counters iz value-bets route-a (ako postoji)
  const g = globalThis;
  const cache = g.__VB_CACHE__;
  const counters = cache?.counters || null;

  async function quick(path) {
    try {
      const r = await fetch(`${base}${path}`, { cache: "no-store" });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) return { ok: false, status: r.status };
      const j = await r.json();
      const key = Object.keys(j).find((k) => Array.isArray(j[k]));
      const count = key ? j[key].length : 0;
      return { ok: true, status: r.status, count, sampleKeys: key ? Object.keys(j[key][0] || {}) : [] };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  const [cryptoProbe, valueProbe] = await Promise.all([
    quick("/api/crypto").catch(() => null),
    quick("/api/value-bets").catch(() => null),
  ]);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    env: {
      API_FOOTBALL_KEY: has("API_FOOTBALL_KEY"),
      SPORTMONKS_KEY: has("SPORTMONKS_KEY"),
      FOOTBALL_DATA_KEY: has("FOOTBALL_DATA_KEY"),
      ODDS_API_KEY: has("ODDS_API_KEY"),
      TZ_DISPLAY: process.env.TZ_DISPLAY || null,
    },
    counters,
    probes: { crypto: cryptoProbe, valueBets: valueProbe },
    now: new Date().toISOString(),
  });
}
