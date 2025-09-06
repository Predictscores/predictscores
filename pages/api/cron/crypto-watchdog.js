// pages/api/cron/crypto-watchdog.js
// Periodično (npr. na 5 min) pokreće osvežavanje kripto signala.
// Radi: pozove /api/crypto?force=1 tako da se KV odmah ažurira pre isteka TTL-a.
// Autentikacija preko CRON_KEY da samo tvoj scheduler može da ga zove.

const { CRON_KEY = "" } = process.env;

export default async function handler(req, res) {
  try {
    const key = (req.query.key || "").toString();
    if (!CRON_KEY || key !== CRON_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const base = getBaseUrl(req); // npr. https://predictscores.vercel.app
    const url = `${base}/api/crypto?force=1`;
    const r = await fetch(url, { cache: "no-store" });
    const json = await r.json().catch(() => ({}));

    return res.status(200).json({
      ok: true,
      triggered: true,
      upstream: { status: r.status, ok: r.ok },
      live_count: json?.count ?? null,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

function getBaseUrl(req) {
  // pokušaj redom: NEXT_PUBLIC_BASE_URL, VERCEL_URL, pa Host iz headera
  const fromEnv =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (fromEnv) return fromEnv;

  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  return `${proto}://${host}`;
}
