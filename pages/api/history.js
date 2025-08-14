// FILE: pages/api/history.js
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (process.env.FEATURE_HISTORY !== "1") {
    return res.status(200).json({ history: [] });
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(200).json({ history: [] });
  }

  try {
    const days = 30;
    const now = new Date();
    const keys = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0, 10);
      keys.push(`vb:day:${ymd}:std`);
      keys.push(`vb:day:${ymd}:reb`);
    }

    const all = [];
    for (const k of keys) {
      const r = await fetch(`${process.env.KV_REST_API_URL}/get/${encodeURIComponent(k)}`, {
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
      });
      if (!r.ok) continue;
      const { result } = await r.json();
      if (!result) continue;
      try {
        const arr = JSON.parse(result);
        all.push(...arr);
      } catch {}
    }

    res.status(200).json({ history: all });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
