// pages/api/cron/refresh-odds.js
// Puni keš kvota u KV (i opcionalno u Upstash) uz skroman budžet poziva.
// 1) batch: /odds?date=YYYY-MM-DD (1 poziv) -> rasporedi po fixture-id
// 2) dopuna per-fixture (limitirano budžetom)
// Ključevi: odds:fixture:<YMD>:<fixtureId>

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const AF_BASE = process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io";
const AF_KEY  = process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL;

// Primarno čuvamo u KV_* (apply-learning već koristi KV).
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// (Opcija) I u Upstash, ako su postavljeni:
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const DAILY_BUDGET = Number(process.env.ODDS_CALL_BUDGET_DAILY || 5000);
const PER_FIXTURE_CAP = Number(process.env.ODDS_PER_FIXTURE_CAP || 200); // max dopuna

export default async function handler(req, res) {
  try {
    if (!AF_KEY) return res.status(200).json({ ok:false, error:"API_FOOTBALL_KEY missing" });

    const ymd = ymdInTZ(new Date(), TZ);

    // 1) povuci fixtures za danas (da znamo koja su fid)
    const fixtures = await fetchJSON(`${AF_BASE}/fixtures?date=${ymd}&timezone=${encodeURIComponent(TZ)}`);
    const fx = Array.isArray(fixtures?.response) ? fixtures.response : [];

    // 2) batch odds za danas (1 poziv)
    const batch = await fetchJSON(`${AF_BASE}/odds?date=${ymd}&timezone=${encodeURIComponent(TZ)}`);
    const arr = Array.isArray(batch?.response) ? batch.response : [];

    // 3) normalizuj i upiši odds per-fixture (iz batch-a)
    const map = new Map();
    for (const row of arr) {
      const fid = row?.fixture?.id;
      if (!fid) continue;
      map.set(fid, normalizeOdds(row));
    }
    await saveManyOdds(ymd, map);

    // 4) dopuni per fixture za one bez kvota (limitirano budžetom)
    const missing = fx.map(r => r?.fixture?.id).filter(id => id && !map.has(id));
    const left = await getBudgetLeft(ymd);
    const take = Math.min(left, PER_FIXTURE_CAP, missing.length);
    let fetched = 0;

    for (let i=0; i<take; i++) {
      const fid = missing[i];
      try {
        const one = await fetchJSON(`${AF_BASE}/odds?fixture=${fid}&timezone=${encodeURIComponent(TZ)}`);
        await bumpBudget(ymd, 1);
        const rows = Array.isArray(one?.response) ? one.response : [];
        if (rows.length) {
          const odds = normalizeOdds(rows[0]);
          if (odds) {
            await saveOdds(ymd, fid, odds);
            fetched++;
          }
        }
      } catch { /* ignore pojedinačne greške */ }
    }

    return res.status(200).json({
      ok: true,
      ymd,
      fixtures: fx.length,
      odds_cached: map.size,
      odds_fetched: fetched,
      budget_used: await getBudgetUsed(ymd),
      budget_limit: DAILY_BUDGET,
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}

/* -------- helpers -------- */

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY, "cache-control": "no-store" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) throw new Error(`Bad content-type for ${url}`);
  return r.json();
}

function normalizeOdds(row) {
  // pokupi best 1X2 kroz sve bookmakere
  let home=null, draw=null, away=null;
  const books = Array.isArray(row?.bookmakers) ? row.bookmakers : row?.odds?.bookmakers || [];
  for (const bk of books) {
    const bets = Array.isArray(bk?.bets) ? bk.bets : [];
    for (const bet of bets) {
      const name = String(bet?.name||"").toLowerCase();
      if (!/match\s*winner|^1x2$|^winner$/.test(name)) continue;
      const vals = Array.isArray(bet?.values) ? bet.values : [];
      for (const v of vals) {
        const lbl = String(v?.value || v?.label || "").toLowerCase();
        const odd = Number(v?.odd);
        if (!Number.isFinite(odd)) continue;
        if (/(^|\b)(home|1)(\b|$)/.test(lbl)) home = Math.max(home ?? 0, odd);
        else if (/(^|\b)(draw|x)(\b|$)/.test(lbl)) draw = Math.max(draw ?? 0, odd);
        else if (/(^|\b)(away|2)(\b|$)/.test(lbl)) away = Math.max(away ?? 0, odd);
      }
    }
  }
  const best = Math.max(home||0, draw||0, away||0) || null;
  const fav  = best == null ? null : (best === home ? "HOME" : best === draw ? "DRAW" : "AWAY");
  return { match_winner: { home, draw, away }, best, fav };
}

function ymdInTZ(d=new Date(), tz=TZ){
  const s = d.toLocaleString("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s).trim();
}

/* ---- storage (KV primarno; Upstash opcionalno) ---- */

async function saveManyOdds(ymd, map) {
  const writes = [];
  for (const [fid, odds] of map.entries()) writes.push(saveOdds(ymd, fid, odds));
  await Promise.all(writes);
}
async function saveOdds(ymd, fid, odds) {
  const key = `odds:fixture:${ymd}:${fid}`;
  // KV (primarno)
  if (KV_URL && KV_TOKEN) {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) }),
    });
  }
  // Upstash (opciono)
  if (UP_URL && UP_TOKEN) {
    await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(odds) }),
    });
  }
}

async function getBudgetUsed(ymd){
  const key = `odds:budget:${ymd}`;
  if (!KV_URL || !KV_TOKEN) return 0;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }});
  const j = await r.json().catch(()=>null);
  const n = Number(j?.result ?? 0);
  return Number.isFinite(n) ? n : 0;
}
async function getBudgetLeft(ymd){
  const used = await getBudgetUsed(ymd);
  return Math.max(DAILY_BUDGET - used, 0);
}
async function bumpBudget(ymd, n){
  if (!KV_URL || !KV_TOKEN || !n) return;
  const key = `odds:budget:${ymd}`;
  await fetch(`${KV_URL}/incrby/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ value: n }),
  }).catch(()=>{});
}
