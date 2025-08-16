// FILE: pages/api/cron/scheduler.js
export const config = { api: { bodyParser: false } };

// Scheduler (slot-based)
// - U tačnim slotovima: preview / rebuild / insights
// - Ne koristi sekvencu "*/" u komentarima; blok-komentari je zatvaraju i lome build.

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const WINDOW_MIN = Number(process.env.SCHEDULER_MINUTE_WINDOW || 4);

function belgradeNowParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const s = fmt.format(now); // "YYYY-MM-DD HH:MM"
  const [date, hm] = s.split(" ");
  const [H, M] = hm.split(":").map(Number);
  return { date, H, M, hm };
}

function mins(h, m) { return h * 60 + m; }

function diffNowTo(targetHM, H, M) {
  const [tH, tM] = targetHM.split(":").map(Number);
  return mins(H, M) - mins(tH, tM); // [0..WINDOW] znači "pogođeno"
}

async function triggerInternal(req, path) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  const origin = `${proto}://${host}`;
  return fetch(`${origin}${path}`, { headers: { "x-internal-cron": "1" } });
}

export default async function handler(req, res) {
  try {
    const { date, H, M, hm } = belgradeNowParts();

    // SLOTOVI
    const slots = [
      // preview noću (K≈6)
      { time: "00:20", key: "preview", path: "/api/locked-floats?preview=1" },
      { time: "06:20", key: "preview", path: "/api/locked-floats?preview=1" },

      // insights (2x)
      { time: "08:05", key: "insights", path: "/api/insights-build" },
      { time: "13:05", key: "insights", path: "/api/insights-build" },

      // rebuild + learning (2x)
      { time: "10:00", key: "rebuild", path: "/api/cron/rebuild" },
      { time: "15:00", key: "rebuild", path: "/api/cron/rebuild" },
    ];

    const matches = [];
    for (const s of slots) {
      const d = diffNowTo(s.time, H, M);
      if (d >= 0 && d <= WINDOW_MIN) matches.push(s);
    }

    const triggered = [];
    for (const m of matches) {
      const ok = await triggerInternal(req, m.path);
      triggered.push({ ...m, status: ok?.status || 0 });
    }

    // FLOTS/SCOUT – periodično; sama ruta ima lock/throttle pa neće preterivati sa spoljnim API pozivima
    const floats = await triggerInternal(req, "/api/locked-floats");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      now: { tz: TZ, hm, date },
      windowMin: WINDOW_MIN,
      triggered,
      floatsStatus: floats?.status || 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
