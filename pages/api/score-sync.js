// FILE: pages/api/score-sync.js
export const config = { api: { bodyParser: false } };

const BASE = "https://v3.football.api-sports.io";
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const MAX_IDS_PER_CALL = 20;

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
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
    body: JSON.stringify({ value: JSON.stringify(value) }),
  });
}
async function afGet(path) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, "x-rapidapi-key": key },
  });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}
function ymd(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE",{ timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"}).format(d);
}
function ymdList(days) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    out.push(ymd(d));
  }
  return out;
}
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function extractScore(fx) {
  const sc = fx?.score || {};
  const ht = sc?.halftime || {};
  const ft = sc?.fulltime || {};
  const ftH = Number.isFinite(Number(ft?.home)) ? Number(ft.home) : Number(sc?.home);
  const ftA = Number.isFinite(Number(ft?.away)) ? Number(ft.away) : Number(sc?.away);
  const htH = Number.isFinite(Number(ht?.home)) ? Number(ht.home) : null;
  const htA = Number.isFinite(Number(ht?.away)) ? Number(ht.away) : null;
  const short = fx?.fixture?.status?.short || "";
  return { ftH, ftA, htH, htA, short };
}

export default async function handler(req, res) {
  try {
    const days = Math.max(1, Math.min(3, Number(req.query.days || 2)));
    const ymds = ymdList(days);

    const wanted = new Set();
    for (const d of ymds) {
      const snap = await kvGet(`vb:day:${d}:last`);
      if (!Array.isArray(snap)) continue;
      for (const p of snap) {
        if (p?.fixture_id) wanted.add(Number(p.fixture_id));
      }
    }
    const ids = Array.from(wanted);

    // preskoči već upisane
    const need = [];
    for (const id of ids) {
      const sc = await kvGet(`vb:score:${id}`);
      if (!sc || sc.ftH == null || sc.ftA == null) need.push(id);
    }

    let written = 0, fetched = 0;
    for (const group of chunk(need, MAX_IDS_PER_CALL)) {
      const rows = await afGet(`/fixtures?ids=${group.join("-")}`);
      fetched += rows.length;
      for (const fx of rows) {
        const id = fx?.fixture?.id;
        if (!id) continue;
        const { ftH, ftA, htH, htA, short } = extractScore(fx);
        if (!Number.isFinite(ftH) || !Number.isFinite(ftA)) continue;
        await kvSet(`vb:score:${id}`, { ftH, ftA, htH, htA, status: short, built_at: new Date().toISOString() });
        written += 1;
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, days, candidates: ids.length, need: need.length, fetched, written });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
