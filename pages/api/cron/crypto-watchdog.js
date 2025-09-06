// pages/api/cron/crypto-watchdog.js
// Watchdog bez Vercel Protection: force refresh /api/crypto uz CRON_KEY verifikaciju.

const { CRON_KEY = "" } = process.env;

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || "");
    if (!CRON_KEY || key !== CRON_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const base = getBaseUrl(req);
    const target = `${base}/api/crypto?force=1&key=${encodeURIComponent(CRON_KEY)}`;
    const r = await fetch(target, {
      cache: "no-store",
      headers: {
        "x-cron-key": CRON_KEY,
        "authorization": `Bearer ${CRON_KEY}`,
        "user-agent": "crypto-watchdog/1.0",
      },
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
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
