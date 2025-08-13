// FILE: pages/api/diag.js
export default async function handler(req, res) {
  // --- base URL iz zaglavlja (radi i na Vercelu)
  const headers = req.headers || {};
  const proto = headers["x-forwarded-proto"] || "http";
  const host = headers["x-forwarded-host"] || headers.host;
  const base = `${proto}://${host}`;

  // --- helpers
  const has = (k) => !!(process.env[k] && String(process.env[k]).trim() !== "");

  async function quick(path) {
    try {
      const r = await fetch(`${base}${path}`, { cache: "no-store" });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        return { ok: false, status: r.status, contentType: ct };
      }
      const j = await r.json();
      // pogodimo prvi niz u odgovoru i izvučemo count + sampleKeys
      const arrKey = Object.keys(j).find((k) => Array.isArray(j[k]));
      const count = arrKey ? j[arrKey].length : 0;
      const sample = arrKey ? (j[arrKey][0] || {}) : {};
      return {
        ok: true,
        status: r.status,
        count,
        arrayKey: arrKey || null,
        sampleKeys: Object.keys(sample),
        meta: Object.fromEntries(
          Object.entries(j).filter(([k, v]) => k.startsWith("_meta"))
        ),
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // --- in-memory counters iz value-bets route-a (ako je kreiran)
  const g = globalThis;
  const vbCache = g.__VB_CACHE__;
  const counters = vbCache?.counters || null;

  // --- paralelni probe osnovnih API-ja u app-u
  const [cryptoProbe, valueProbe, footballProbe] = await Promise.all([
    quick("/api/crypto").catch(() => null),
    quick("/api/value-bets").catch(() => null),
    quick("/api/football").catch(() => null),
  ]);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    now: new Date().toISOString(),
    env: {
      // oba naziva za AF ključ proveravamo (ne otkrivamo vrednosti!)
      API_FOOTBALL_KEY: has("API_FOOTBALL_KEY"),
      NEXT_PUBLIC_API_FOOTBALL_KEY: has("NEXT_PUBLIC_API_FOOTBALL_KEY"),
      SPORTMONKS_KEY: has("SPORTMONKS_KEY"),
      FOOTBALL_DATA_KEY: has("FOOTBALL_DATA_KEY"),
      ODDS_API_KEY: has("ODDS_API_KEY"),
      TZ_DISPLAY: process.env.TZ_DISPLAY || null,
    },
    counters,               // npr. { day: 'YYYY-MM-DD', apiFootball: N }
    probes: {
      crypto: cryptoProbe,  // /api/crypto
      valueBets: valueProbe,// /api/value-bets
      football: footballProbe, // /api/football
    },
    base,
    note: "Ovaj endpoint NE izbacuje vrednosti ključeva, samo prisutnost i brze probe.",
  });
}
