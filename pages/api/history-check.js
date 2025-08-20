// FILE: pages/api/history-check.js
export const config = { api: { bodyParser: false } };

// ---- KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  try {
    const js = await r.json();
    return js?.result ?? null;
  } catch { return null; }
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}

// ---- tiny parsers
function toArrayMaybe(raw) {
  try {
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner === "string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  } catch {}
  return [];
}

function lastDays(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ---- API-FOOTBALL settle
async function fetchFixtureScore(fixtureId) {
  const key =
    process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) return null;

  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures?id=${fixtureId}`,
    { headers: { "x-apisports-key": key } }
  );
  if (!r.ok) return null;

  const data = await r.json().catch(() => null);
  const obj = data?.response?.[0];
  if (!obj) return null;

  const statusShort = obj?.fixture?.status?.short || "";
  const statusLong = obj?.fixture?.status?.long || "";
  const doneSet = new Set(["FT", "AET", "PEN"]);

  // FT rezultat: goals.home/away, ili fallback na score.fulltime.* (a po potrebi saberemo ET/PEN)
  let ftH = obj?.goals?.home;
  let ftA = obj?.goals?.away;

  if (!Number.isFinite(ftH) || !Number.isFinite(ftA)) {
    const fh = obj?.score?.fulltime?.home;
    const fa = obj?.score?.fulltime?.away;
    if (Number.isFinite(fh) && Number.isFinite(fa)) {
      ftH = fh;
      ftA = fa;
    }
  }

  // halftime (može biti null)
  const htH = obj?.score?.halftime?.home ?? null;
  const htA = obj?.score?.halftime?.away ?? null;

  const done =
    doneSet.has(statusShort) ||
    /finished|after extra time|penalties/i.test(statusLong);

  if (!done || !Number.isFinite(ftH) || !Number.isFinite(ftA)) return null;

  return {
    status: statusShort || statusLong || "FT",
    ftH,
    ftA,
    htH,
    htA,
    ft: `${ftH}:${ftA}`,
    ht: Number.isFinite(htH) && Number.isFinite(htA) ? `${htH}:${htA}` : null
  };
}

// ---- collect fixtures from both snapshots and history-top keys
async function collectFixtureIdsForDay(ymd) {
  const seen = new Set();
  const push = (arr) => {
    for (const p of toArrayMaybe(arr)) {
      const fid = p?.fixture_id;
      if (fid && !seen.has(fid)) seen.add(fid);
    }
  };

  // glavni dnevni snapshot (union)
  push(await kvGet(`vb:day:${ymd}:last`));

  // history top lists po slotovima (ako postoje)
  push(await kvGet(`hist:${ymd}:am`));
  push(await kvGet(`hist:${ymd}:pm`));
  push(await kvGet(`hist:${ymd}:late`));

  return Array.from(seen);
}

export default async function handler(req, res) {
  try {
    if (process.env.FEATURE_HISTORY !== "1") {
      return res.status(200).json({ updated: 0, note: "history disabled" });
    }

    const days = Math.max(1, Math.min(14, Number(req.query.days || 2)));
    const ymds = lastDays(days);

    let updated = 0;

    for (const ymd of ymds) {
      const fids = await collectFixtureIdsForDay(ymd);
      if (!fids.length) continue;

      for (const fid of fids) {
        const scoreKey = `vb:score:${fid}`;
        const has = await kvGet(scoreKey);
        // ako već imamo ft, preskoči
        try {
          const parsed = typeof has === "string" ? JSON.parse(has) : has;
          if (parsed && parsed.ft) continue;
        } catch { /* ignore */ }

        const score = await fetchFixtureScore(fid);
        if (!score) continue;

        await kvSet(scoreKey, score);
        updated++;
      }
    }

    return res.status(200).json({ updated });
  } catch (e) {
    return res
      .status(500)
      .json({ error: String(e && e.message ? e.message : e) });
  }
}
