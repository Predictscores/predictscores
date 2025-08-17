// =============================================
// Locked snapshot čitanje iz KV; self-heal posle 10:00
// =============================================

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);

function ymdTZ(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(d);
}

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}

function toList(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.value_bets)) return v.value_bets;
      return null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && Array.isArray(raw.value_bets)) {
    return raw.value_bets;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const today = ymdTZ();

    // Ručni trigger rebuild-a (opciono)
    if (req.query?.rebuild === "1") {
      const proto =
        req.headers["x-forwarded-proto"] ||
        (req.headers["x-forwarded-protocol"] || "https");
      const host =
        req.headers["x-forwarded-host"] ||
        req.headers["x-forwarded-hostname"] ||
        req.headers.host;
      const base = `${proto}://${host}`;
      // fire-and-forget
      fetch(`${base}/api/cron/rebuild`).catch(() => {});
    }

    // 1) last
    const last = await kvGet(`vb:day:${today}:last`);
    const lastList = toList(last);
    if (lastList && lastList.length) {
      return res.status(200).json({
        value_bets: lastList.slice(0, VB_LIMIT),
        built_at: new Date().toISOString(),
        day: today,
        source: "locked-cache",
      });
    }

    // 2) preko rev pointera
    const rev = await kvGet(`vb:day:${today}:rev`);
    const rnum = parseInt(rev, 10);
    if (Number.isFinite(rnum) && rnum > 0) {
      const snap = await kvGet(`vb:day:${today}:rev:${rnum}`);
      const list = toList(snap);
      if (list && list.length) {
        return res.status(200).json({
          value_bets: list.slice(0, VB_LIMIT),
          built_at: new Date().toISOString(),
          day: today,
          source: "locked-rev",
        });
      }
    }

    // 3) posle 10:00 pokreni self-heal sa cooldown-om
    const nowParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .reduce((a, p) => ((a[p.type] = p.value), a), {});
    const hour = parseInt(nowParts.hour, 10);

    if (hour >= 10) {
      const cooldownKey = `vb:ensure:cooldown:${today}`;
      const cd = await kvGet(cooldownKey);
      if (!cd) {
        // set cooldown 8 min
        await fetch(`${KV_URL}/set/${encodeURIComponent(cooldownKey)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${KV_TOKEN}`,
          },
          body: JSON.stringify({ value: "1", ex: 8 * 60 }),
        }).catch(() => {});

        const proto =
          req.headers["x-forwarded-proto"] ||
          (req.headers["x-forwarded-protocol"] || "https");
        const host =
          req.headers["x-forwarded-host"] ||
          req.headers["x-forwarded-hostname"] ||
          req.headers.host;
        const base = `${proto}://${host}`;
        fetch(`${base}/api/cron/rebuild`).catch(() => {});
        return res.status(200).json({
          value_bets: [],
          built_at: new Date().toISOString(),
          day: today,
          source: "ensure-started",
        });
      }
    }

    // 4) Još nema snapshota
    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day: today,
      source: "ensure-wait",
    });
  } catch (e) {
    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day: ymdTZ(),
      source: "error",
      error: String(e?.message || e),
    });
  }
}
