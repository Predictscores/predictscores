// FILE: pages/api/diag.js
export default async function handler(req, res) {
  const headers = req.headers || {};
  const proto = headers["x-forwarded-proto"] || "http";
  const host = headers["x-forwarded-host"] || headers.host;
  const base = `${proto}://${host}`;

  const has = (k) => !!(process.env[k] && String(process.env[k]).trim() !== "");

  // in-memory counters (ako postoji)
  const g = globalThis;
  const vbCache = g.__VB_CACHE__;
  const counters = vbCache?.counters || null;

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    now: new Date().toISOString(),
    env: {
      API_FOOTBALL_KEY: has("API_FOOTBALL_KEY") || has("NEXT_PUBLIC_API_FOOTBALL_KEY"),
      SPORTMONKS_KEY: has("SPORTMONKS_KEY"),
      FOOTBALL_DATA_KEY: has("FOOTBALL_DATA_KEY"),
      ODDS_API_KEY: has("ODDS_API_KEY"),
      TZ_DISPLAY: process.env.TZ_DISPLAY || null,
    },
    counters,
    base,
    note: "Light diag: bez probe ka generatorima. Ovaj endpoint NE otkriva vrednosti ključeva.",
  });
}
