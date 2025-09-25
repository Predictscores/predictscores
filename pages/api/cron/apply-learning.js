export const config = { runtime: "nodejs" };
export const dynamic = "force-dynamic";

export default async function handler(req, res) {
  if (req?.query?.probe === "1") {
    return res.status(200).json({ ok: true, probe: true });
  }

  try {
    const mod = await import("./apply-learning.impl");
    const run = mod?.runApplyLearning;
    if (typeof run !== "function") {
      throw new Error("impl missing");
    }

    try {
      return await run(req, res);
    } catch (err) {
      const message = err?.message || String(err);
      return res.status(200).json({
        ok: false,
        error: { phase: "run", message },
      });
    }
  } catch (err) {
    const message = err?.message || String(err);
    return res.status(200).json({
      ok: false,
      error: { phase: "import", message },
    });
  }
}
