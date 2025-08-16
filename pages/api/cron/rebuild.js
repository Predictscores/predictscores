// FILE: pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 15));
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2));

function ymd(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}
function isUEFA(name = "") {
  const n = String(name).toLowerCase();
  return n.includes("champions league") || n.includes("europa league") || n.includes("conference league");
}
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }
function filterFuture(arr=[]) {
  const now = Date.now();
  return arr.filter(x => {
    const iso = x?.datetime_local?.starting_at?.date_time;
    const t = parseISO(iso);
    return Number.isFinite(t) && t > now;
  });
}
function rankBase(arr = []) {
  return arr.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
    const s = (b._score||0) - (a._score||0);
    if (s) return s;
    const eA = Number.isFinite(a.edge_pp)?a.edge_pp:-999;
    const eB = Number.isFinite(b.edge_pp)?b.edge_pp:-999;
    if (eB !== eA) return eB - eA;
    return String(a.fixture_id||"").localeCompare(String(b.fixture_id||""));
  });
}

/* KV */
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(()=>null);
  if (!r || !r.ok) return null;
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
  }).catch(()=>{});
}
async function kvIncr(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 0;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(["INCR", key])
  }).catch(()=>null);
  if (!r) return 0;
  const j = await r.json().catch(()=>({}));
  return Number(j?.result||0);
}

export default async function handler(req, res) {
  try {
    // 1) pozovi generator sa timeout-om
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60_000); // 60s
    let raw = [];
    try {
      const gen = await fetch(`${origin}/api/value-bets`, {
        headers: { "x-internal": "1" },
        signal: ac.signal
      });
      clearTimeout(t);
      if (!gen.ok) {
        const txt = await gen.text().catch(()=>String(gen.status));
        return res.status(502).json({ ok:false, error:"generator_failed", details:txt });
      }
      const payload = await gen.json().catch(()=>({}));
      raw = Array.isArray(payload?.value_bets) ? payload.value_bets : [];
    } catch (err) {
      return res.status(504).json({ ok:false, error:"generator_timeout_or_error", details:String(err?.message||err) });
    }

    // 2) FUTURE + RANK + limit po ligi + LIMIT
    const future = filterFuture(raw);
    const ranked = rankBase(future);

    const perLeague = new Map();
    const pinned = [];
    const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();
    for (const p of ranked) {
      const lname = p?.league?.name || "";
      const key = keyOfLeague(p);
      if (!isUEFA(lname)) {
        const cnt = perLeague.get(key) || 0;
        if (cnt >= MAX_PER_LEAGUE) continue;
        perLeague.set(key, cnt + 1);
      }
      pinned.push(p);
      if (pinned.length >= LIMIT) break;
    }

    const today = ymd();
    await kvSet(`vb:day:${today}:last`, pinned);
    const newRev = await kvIncr(`vb:day:${today}:rev`);

    return res.status(200).json({
      ok: true,
      snapshot_for: today,
      count: pinned.length,
      rev: newRev || 0
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
