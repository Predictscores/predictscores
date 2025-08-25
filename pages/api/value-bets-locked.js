// FILE: pages/api/value-bets-locked.js
// Vraća zaključani feed iz KV: vb:day:<ymd>:last + vb:meta:<ymd>:last_meta
export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function todayYMD(tz = TZ) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date()); // YYYY-MM-DD
  } catch {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) throw new Error("KV env missing");
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j === "object" && "result" in j ? j.result : j;
}

function parseMaybe(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  try {
    const ymd = String(req.query.ymd || todayYMD());

    // items
    const rawLast = await kvGet(`vb:day:${ymd}:last`);
    const parsedLast = parseMaybe(rawLast);
    const items = Array.isArray(parsedLast?.items)
      ? parsedLast.items
      : Array.isArray(parsedLast)
      ? parsedLast
      : [];

    // meta
    const rawMeta = await kvGet(`vb:meta:${ymd}:last_meta`).catch(() => null);
    const meta = parseMaybe(rawMeta) || {};
    const builtAt = meta.built_at || meta.builtAt || null;
    const slot = meta.slot || null;

    res.status(200).end(JSON.stringify({
      ok: true,
      ymd,
      source: "last",
      built_at: builtAt,
      slot,
      items
    }));
  } catch (e) {
    res.status(200).end(JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      ymd: null,
      source: "last",
      built_at: null,
      slot: null,
      items: []
    }));
  }
}
