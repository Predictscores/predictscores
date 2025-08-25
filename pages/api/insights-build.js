// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  try {
    const js = await r.json();
    return "result" in js ? js.result : js;
  } catch { return null; }
}
async function kvGetJSON(key) {
  const raw = await kvGetRaw(key);
  if (raw == null) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}
async function kvSetJSON(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body
  });
  return r.ok;
}

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();

    // primarni union ključ
    let union = await kvGetJSON(`vb:day:${ymd}:union`);
    // fallback ako postoji stara šema
    if (!Array.isArray(union) || union.length === 0) {
      const alt = await kvGetJSON(`vb:day:${ymd}:slots-union`);
      if (Array.isArray(alt) && alt.length) union = alt;
    }

    if (!Array.isArray(union) || union.length === 0) {
      return res.status(200).json({ ok: true, updated: 0, reason: "union empty" });
    }

    // touch meta (ovde bi išla prava generacija bullets-a, ali ne trošimo spoljne API-je)
    await kvSetJSON(`vb:meta:${ymd}:insights_touch`, JSON.stringify({
      ymd, updated_at: new Date().toISOString(), size: union.length
    }));

    return res.status(200).json({ ok: true, updated: union.length, ymd });
  } catch (e) {
    return res.status(200).json({ ok: false, updated: 0, error: String(e?.message || e) });
  }
}
