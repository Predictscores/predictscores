// FILE: pages/api/history-check.js
export const config = { api: { bodyParser: false } };

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}

// API-Football: fixtures?id=...
async function fetchFixtureScore(fixtureId) {
  const key = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) return null;
  const r = await fetch(`https://v3.football.api-sports.io/fixtures?id=${fixtureId}`, {
    headers: { "x-apisports-key": key }
  });
  if (!r.ok) return null;
  const data = await r.json();
  const obj = data?.response?.[0];
  if (!obj) return null;

  const status = obj?.fixture?.status?.short || "";
  const ftH = obj?.goals?.home ?? null;
  const ftA = obj?.goals?.away ?? null;
  const htH = obj?.score?.halftime?.home ?? null;
  const htA = obj?.score?.halftime?.away ?? null;

  // Samo kad je zavrseno (FT/AET/PEN)
  const done = ["FT","AET","PEN"].includes(status) && ftH !== null && ftA !== null;
  if (!done) return null;

  return { status, ftH, ftA, htH, htA, ft: `${ftH}:${ftA}`, ht: (htH!=null&&htA!=null)?`${htH}:${htA}`:null };
}

export default async function handler(req, res) {
  if (process.env.FEATURE_HISTORY !== "1") {
    return res.status(200).json({ updated: 0, note: "history disabled" });
  }
  try {
    const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) return res.status(200).json({ updated: 0, note: "kv not configured" });

    const days = Math.max(1, Math.min(7, Number(req.query.days || 2)));
    const now = new Date();
    let updated = 0;

    for (let i = 0; i < days; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0,10);
      const snapshot = await kvGet(`vb:day:${ymd}:last`);
      if (!Array.isArray(snapshot) || !snapshot.length) continue;

      for (const p of snapshot) {
        const fid = p?.fixture_id;
        if (!fid) continue;
        const scoreKey = `vb:score:${fid}`;
        const has = await kvGet(scoreKey);
        if (has && has.ft) continue; // vec imamo

        const score = await fetchFixtureScore(fid);
        if (!score) continue;

        await kvSet(scoreKey, score);
        updated++;
      }
    }
    return res.status(200).json({ updated });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
