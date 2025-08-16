// FILE: pages/api/cron/scheduler.js
export const config = { api: { bodyParser: false } };

// Minimalni, robustan scheduler za 2 crona (08:00 i 13:00 UTC):
// - kada se pozove, UVEK poziva rebuild, pa odmah insights.
// - bez slot-računanja i prozora, jer poziv tačno u 10:00/15:00 dolazi iz Vercel crona.

async function triggerInternal(req, path) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const origin = `${proto}://${host}`;
    const r = await fetch(`${origin}${path}`, { headers: { "x-internal-cron": "1" } });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  try {
    const startedAt = new Date().toISOString();

    // 1) Rebuild (lock feed)
    const r1 = await triggerInternal(req, "/api/cron/rebuild");

    // 2) Insights odmah nakon lock-a (nema trećeg crona, nema :05 slotova)
    const r2 = await triggerInternal(req, "/api/insights-build");

    // 3) (opciono) Floats/Smart – best-effort; ignoriši ako nema rute
    const r3 = await triggerInternal(req, "/api/locked-floats");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      startedAt,
      steps: [
        { step: "rebuild",  status: r1.status, ok: r1.ok },
        { step: "insights", status: r2.status, ok: r2.ok },
        { step: "floats",   status: r3.status, ok: r3.ok },
      ],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
