// FILE: pages/api/cron/rebuild.js
// Zaključava dnevni snapshot u KV:
//  - vb:day:YYYY-MM-DD:last  (array pickova)
//  - vb:day:YYYY-MM-DD:rev   (brojač; TTL 2d)
//  - vb:day:YYYY-MM-DD:rev:<n> (verzionisani snapshot; TTL 2d)

export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdTZ(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function unwrapKV(raw) {
  let v = raw;
  try {
    if (typeof v === "string") {
      const p = JSON.parse(v);
      v = (p && typeof p === "object" && "value" in p) ? p.value : p;
    }
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) v = JSON.parse(v);
  } catch {}
  return v;
}
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
  } catch { return null; }
}
async function kvSet(key, value, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
    if (opts.ex) body.ex = opts.ex;
    if (opts.nx) body.nx = true;
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

export default async function handler(req, res) {
  try {
    const today = ymdTZ();

    // 1) pozovi generator interno
    const proto = req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-hostname"] || req.headers.host;
    const base  = `${proto}://${host}`;

    const r = await fetch(`${base}/api/value-bets`, { cache: "no-store" });
    const j = await r.json().catch(()=>({ value_bets: [] }));
    const list = Array.isArray(j?.value_bets) ? j.value_bets : (Array.isArray(j) ? j : []);

    // 2) upiši snapshot u KV
    const lastKey = `vb:day:${today}:last`;
    await kvSet(lastKey, list, { ex: 2 * 24 * 3600 }); // 2 dana

    let rev = 0;
    const revRaw = await kvGet(`vb:day:${today}:rev`);
    try { rev = parseInt(String(revRaw?.value ?? revRaw ?? "0"), 10) || 0; } catch {}
    rev += 1;

    await kvSet(`vb:day:${today}:rev`, String(rev), { ex: 2 * 24 * 3600 });
    await kvSet(`vb:day:${today}:rev:${rev}`, list, { ex: 2 * 24 * 3600 });

    return res.status(200).json({
      ok: true,
      snapshot_for: today,
      count: list.length,
      rev
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
