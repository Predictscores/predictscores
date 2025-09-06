// pages/api/cron/crypto-watchdog.js
// Ping koji forsira osvežavanje kripto signala i PROSLEĐUJE tajni ključ ka /api/crypto.
// Pokriva oba slučaja zaštite: preko header-a i preko query parametra.

const { CRON_KEY = "" } = process.env;

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || "");
    if (!CRON_KEY || key !== CRON_KEY) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const base = getBaseUrl(req); // npr. https://predictscores.vercel.app
    // Prosledi ključ i u query (key=...) za slučaj da middleware to očekuje.
    const target = `${base}/api/crypto?force=1&key=${encodeURIComponent(CRON_KEY)}`;

    // Prosledi ključ i u header-ima (x-cron-key + Authorization: Bearer ...)
    const r = await fetch(target, {
      cache: "no-store",
      headers: {
        "x-cron-key": CRON_KEY,
        "authorization": `Bearer ${CRON_KEY}`,
      },
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch {}

    return res.status(200).json({
      ok: true,
      triggered: true,
      upstream: { status: r.status, ok: r.ok },
      live_count: json?.count ?? null,
      ts: Date.now(),
      // mali debug snapshot (bezbedno): ili JSON ili prvih 200 znakova teksta
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
