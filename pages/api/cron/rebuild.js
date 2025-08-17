// =============================================
// Build dnevnog snapshot-a i upis u Upstash KV
// Env: KV_REST_API_URL, KV_REST_API_TOKEN, TZ_DISPLAY (opc), VB_LIMIT (opc)
// =============================================

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const VB_LIMIT = parseInt(process.env.VB_LIMIT || "25", 10);

function ymdBelgrade(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(d); // YYYY-MM-DD
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

async function kvSet(key, value, opts = {}) {
  const body = {
    value: typeof value === "string" ? value : JSON.stringify(value),
  };
  if (opts.ex) body.ex = opts.ex; // TTL u sekundama
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify(body),
  }).catch(() => null);
  return !!(r && r.ok);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 1) Povuci svežu listu sa /api/value-bets (isti host)
    const proto =
      req.headers["x-forwarded-proto"] ||
      (req.headers["x-forwarded-protocol"] || "https");
    const host =
      req.headers["x-forwarded-host"] ||
      req.headers["x-forwarded-hostname"] ||
      req.headers.host;
    const base = `${proto}://${host}`;

    const gen = await fetch(`${base}/api/value-bets`, { cache: "no-store" });
    const payload = await gen.json().catch(() => ({}));
    const list = Array.isArray(payload?.value_bets)
      ? payload.value_bets
      : Array.isArray(payload)
      ? payload
      : [];

    const today = ymdBelgrade();

    // 2) REV brojač i upis snapshot-a
    const revKey = `vb:day:${today}:rev`;
    const lastKey = `vb:day:${today}:last`;

    let currentRev = await kvGet(revKey);
    const revNum = Number.parseInt(currentRev, 10);
    const nextRev = Number.isFinite(revNum) ? revNum + 1 : 1;

    const snapshot = {
      value_bets: list.slice(0, VB_LIMIT),
      built_at: new Date().toISOString(),
      day: today,
    };

    // Pišemo pod rev i pod last; 48h TTL
    await kvSet(`vb:day:${today}:rev:${nextRev}`, snapshot, { ex: 48 * 3600 });
    await kvSet(lastKey, snapshot, { ex: 48 * 3600 });
    await kvSet(revKey, String(nextRev), { ex: 48 * 3600 });

    return res.status(200).json({
      ok: true,
      snapshot_for: today,
      count: snapshot.value_bets.length,
      rev: nextRev, // UVEK broj, nikad null
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: String(e?.message || e) });
  }
}
