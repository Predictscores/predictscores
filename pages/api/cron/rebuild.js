export const config = { api: { bodyParser: false } };

function originFromReq(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}`;
}

export default async function handler(req, res) {
  try {
    const origin = originFromReq(req);

    // 1) Generiši i zaključa listu
    const gen = await fetch(`${origin}/api/value-bets-locked?rebuild=1`, {
      headers: { "x-internal": "1" }
    });
    const status = gen.status;

    // 2) Odmah nakon: insight i jedan floats prolaz
    await fetch(`${origin}/api/insights-build`, { headers: { "x-internal": "1" } });
    await fetch(`${origin}/api/locked-floats`, { headers: { "x-internal": "1" } });

    res.setHeader("Cache-Control", "no-store");
    res.status(status).json({ ok: status >= 200 && status < 300 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
