// pages/api/cron/crypto-watchdog.js
// Forsira osvežavanje kripto signala i PROSLEĐUJE tajni ključ + Vercel Protection Bypass token
// kako bi zaobišao "Authentication Required" stranicu.
//
// ENV koje koristi:
// - CRON_KEY               (tvoja tajna lozinka za watchdog endpoint)
// - VERCEL_BYPASS_TOKEN    (Vercel Protection → Bypass Tokens → Create Token)

const { CRON_KEY = "", VERCEL_BYPASS_TOKEN = "" } = process.env;

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || "");
    if (!CRON_KEY || key !== CRON_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const base = getBaseUrl(req); // npr. https://predictscores.vercel.app
    const target = `${base}/api/crypto?force=1`;

    const headers = {
      "user-agent": "crypto-watchdog/1.0",
      // prosledi i naš ključ (ako tvoj /api/crypto ili neki middleware to očekuje)
      "x-cron-key": CRON_KEY,
      "authorization": `Bearer ${CRON_KEY}`,
    };

    // Ako je uključena Vercel Protection, prosledi bypass token u headeru i kao cookie
    if (VERCEL_BYPASS_TOKEN) {
      headers["x-vercel-protection-bypass"] = VERCEL_BYPASS_TOKEN;
      headers["cookie"] = `vercel_bypass=${VERCEL_BYPASS_TOKEN}`;
    }

    const r = await fetch(target, { cache: "no-store", headers });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {}

    return res.status(200).json({
      ok: true,
      triggered: true,
      upstream: { status: r.status, ok: r.ok },
      live_count: json?.count ?? null,
      ts: Date.now(),
      sample: json ?? text.slice(0, 200),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

function getBaseUrl(req) {
  const fromEnv =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (fromEnv) return fromEnv;

  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = String(req.headers["x-forwarded-proto"] || "https");
  return `${proto}://${host}`;
}
