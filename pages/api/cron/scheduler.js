export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }).format(d));
const slotFromHour = h => (h < 10 ? "late" : h < 15 ? "am" : "pm");
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const firstQueryValue = (value) => Array.isArray(value) ? value[0] : value;

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
  const qSlotRaw = firstQueryValue(req?.query?.slot);
  const qSlot = canonicalSlot(qSlotRaw);
  if (qSlot !== "auto") return qSlot;

  const cronHints = [
    firstQueryValue(req?.query?.cron),
    firstQueryValue(req?.query?.slot_hint),
    firstQueryValue(req?.query?.id),
    firstQueryValue(req?.query?.identifier),
    firstQueryValue(req?.query?.cron_id),
    firstQueryValue(req?.query?.schedule),
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

function resolveYmd(req, now) {
  const qYmd = String(firstQueryValue(req?.query?.ymd) || "").trim();
  if (YMD_REGEX.test(qYmd)) return qYmd;
  return ymdInTZ(now || new Date(), TZ);
}

function buildQueryString(reqQuery, resolved) {
  const params = new URLSearchParams();
  if (reqQuery && typeof reqQuery === "object") {
    for (const [key, value] of Object.entries(reqQuery)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v == null) continue;
          params.append(key, String(v));
        }
      } else {
        params.append(key, String(value));
      }
    }
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function triggerInternal(req, path) {
  try {
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const origin = `${proto}://${host}`;
    const r = await fetch(`${origin}${path}`, { headers: { "x-internal-cron": "1" } });
    const text = await r.text().catch(() => "");
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    return { ok: r.ok, status: r.status, body, raw: text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  try {
    const startedAt = new Date().toISOString();
    const now = new Date();
    const slot = resolveSlot(req, now);
    const ymd = resolveYmd(req, now);
    const queryString = buildQueryString(req?.query || {}, { slot, ymd });

    const steps = [];
    const notes = [];

    const rebuild = await triggerInternal(req, `/api/cron/rebuild${queryString}`);
    steps.push({ step: "rebuild", status: rebuild.status, ok: rebuild.ok, body: rebuild.body, error: rebuild.error });

    const refresh = await triggerInternal(req, `/api/cron/refresh-odds${queryString}`);
    steps.push({ step: "refresh-odds", status: refresh.status, ok: refresh.ok, body: refresh.body, error: refresh.error });

    const refreshBody = refresh?.body && typeof refresh.body === "object" ? refresh.body : null;
    const refreshTraceLen = Array.isArray(refreshBody?.trace) ? refreshBody.trace.length : null;
    const refreshUpdated = typeof refreshBody?.updated === "number" ? refreshBody.updated : null;
    if (refreshTraceLen === 0 || refreshUpdated === 0) {
      notes.push({ step: "refresh-odds", note: "no_updates", traceLength: refreshTraceLen, updated: refreshUpdated });
    }

    const apply = await triggerInternal(req, `/api/cron/apply-learning${queryString}`);
    steps.push({ step: "apply-learning", status: apply.status, ok: apply.ok, body: apply.body, error: apply.error });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: steps.every((s) => s.ok !== false),
      startedAt,
      slot,
      ymd,
      notes: notes.length ? notes : undefined,
      steps,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
