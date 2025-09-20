export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }).format(d));
const slotFromHour = h => (h < 10 ? "late" : h < 15 ? "am" : "pm");

/* ---------- slot resolution ---------- */
const canonicalSlot = (x) => {
  const v = String(x ?? "auto").toLowerCase();
  return v === "late" || v === "am" || v === "pm" ? v : "auto";
};

function slotFromCronIdentifier(hint, now) {
  if (!hint) return null;
  const raw = String(hint || "").trim();
  if (!raw) return null;

  const direct = canonicalSlot(raw);
  if (direct !== "auto") return direct;

  const matchNamed = raw.toLowerCase().match(/\b(late|am|pm)\b/);
  if (matchNamed) return matchNamed[1];

  const parts = raw.replace(/\s+/g, " ").split(" ");
  if (parts.length >= 2) {
    const minute = Number(parts[0]);
    const hour = Number(parts[1]);
    if (Number.isFinite(hour)) {
      const base = now ? new Date(now) : new Date();
      const candidate = new Date(Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate(),
        hour,
        Number.isFinite(minute) ? minute : 0,
        0,
        0
      ));
      const hLocal = hourInTZ(candidate, TZ);
      return slotFromHour(hLocal);
    }
  }
  return null;
}

function resolveSlot(req, now) {
  const qSlot = canonicalSlot(req?.query?.slot);
  if (qSlot !== "auto") return qSlot;

  const cronHints = [
    req?.query?.cron,
    req?.query?.slot_hint,
    req?.query?.id,
    req?.query?.identifier,
    req?.query?.cron_id,
    req?.query?.schedule,
    req?.headers?.["x-vercel-cron"],
    req?.headers?.["x-vercel-cron-trigger"],
    req?.headers?.["x-vercel-schedule"],
    req?.headers?.["x-cron-id"],
    req?.headers?.["x-cron-slot"],
    req?.headers?.["x-schedule-id"],
  ];
  for (const hint of cronHints) {
    const slot = slotFromCronIdentifier(hint, now);
    if (slot) return slot;
  }

  const h = hourInTZ(now || new Date(), TZ);
  return slotFromHour(h);
}

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
    const now = new Date();
    const slot = resolveSlot(req, now);
    const slotParam = `slot=${encodeURIComponent(slot)}`;

    // 1) Rebuild (lock feed)
    const r1 = await triggerInternal(req, `/api/cron/rebuild?${slotParam}`);

    // 2) Insights odmah nakon lock-a
    const r2 = await triggerInternal(req, `/api/insights-build?${slotParam}`);

    // 3) (opciono) Floats/Smart – best-effort; ignoriši ako nema rute
    const r3 = await triggerInternal(req, "/api/locked-floats");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      startedAt,
      slot,
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
