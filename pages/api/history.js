// pages/api/history.js
// Legacy adapter: čita hist:index + hist:<YMD>:<slot> i vraća `items` i `history`.

export const config = { runtime: "nodejs" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

async function kvGet(key) {
  if (!KV_URL || (!KV_TOKEN && !KV_TOKEN_RO)) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.result === "undefined") return null;
    try { return JSON.parse(j.result); } catch { return j.result; }
  } catch { return null; }
}

function parseYMD(s){ const m = String(s||"").match(/^(\d{4})-(\d{2})-(\d{2})/); return m? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null; }
function daysAgoUTC(d){ const now = new Date(); return (now - d) / 86400000; }

export default async function handler(req, res) {
  try {
    const days = Math.max(1, Math.min(60, Number(req.query.days || 14)));
    const index = await kvGet("hist:index");
    const tags = Array.isArray(index) ? index : [];

    const selected = [];
    for (const tag of tags) {
      const dt = parseYMD(tag);
      if (!dt) continue;
      if (daysAgoUTC(dt) <= days) selected.push(tag);
    }

    const buckets = await Promise.all(selected.slice(0, 120).map(t => kvGet(`hist:${t}`)));
    const flat = buckets
      .filter(Array.isArray)
      .flat()
      .map(it => {
        const raw = it?.pick;
        const str = typeof raw === "string" ? raw :
          (it?.selection_label || (it?.pick_code==="1"?"Home":it?.pick_code==="2"?"Away":"Draw"));
        const home = it.home || it?.teams?.home || "";
        const away = it.away || it?.teams?.away || "";
        return { ...it, pick: str, selection: str, home, away };
      });

    return res.status(200).json({ ok: true, items: flat, history: flat, count: flat.length, index: selected });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
