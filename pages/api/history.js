// pages/api/history.js
// Vrati istoriju po slotovima iz KV: hist:<YMD>:<slot> + hist:index

export const config = { runtime: "nodejs" };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

async function kvGet(key) {
  if (!KV_URL || (!KV_TOKEN && !KV_TOKEN_RO)) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || typeof j.result === "undefined") return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}

export default async function handler(req, res) {
  try {
    const index = (await kvGet("hist:index")) || [];
    const latest = [];
    for (const tag of index.slice(0, 30)) {
      const data = await kvGet(`hist:${tag}`);
      if (Array.isArray(data)) latest.push({ tag, items: data.length });
    }
    return res.status(200).json({ ok: true, index, latest });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
