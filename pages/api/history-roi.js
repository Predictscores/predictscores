// pages/api/history-roi.js
export const config = { api: { bodyParser: false } };

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{ headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) { trace && trace.push({ get:key, ok:false, err:String(e?.message||e) }); }
  }
  return { raw:null, flavor:null };
}

/* ---------- helpers ---------- */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const isValidYmd = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||""));
const onlyMarketsCSV = (process.env.HISTORY_ALLOWED_MARKETS || "h2h").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
const allowSet = new Set(onlyMarketsCSV.length ? onlyMarketsCSV : ["h2h"]);
const arrFromAny = x => Array.isArray(x) ? x
  : (x && typeof x==="object" && Array.isArray(x.items)) ? x.items
  : (x && typeof x==="object" && Array.isArray(x.history)) ? x.history
  : (x && typeof x==="object" && Array.isArray(x.list)) ? x.list : [];
const dedupKey = e => `${e?.fixture_id||e?.id||"?"}__${String(e?.market_key||"").toLowerCase()}__${String(e?.pick||"").toLowerCase()}`;

function filterAllowed(arr) {
  const by = new Map();
  for (const e of (arr||[])) {
    const mkey = String(e?.market_key||"").toLowerCase();
    if (!allowSet.has(mkey)) continue;
    const k = dedupKey(e);
    if (!by.has(k)) by.set(k, e);
  }
  return Array.from(by.values());
}

/**
 * Jednostavan ROI:
 * - stake = 1 po picku
 * - ako je result === "win" ili won===true → profit = (price_snapshot - 1)
 * - ako je "loss" → profit = -1
 * - ako nema rezultata → ignoriši (pending)
 */
function computeROI(items) {
  let played = 0, wins = 0, profit = 0, avgOdds = 0;
  for (const e of (items||[])) {
    const res = (e?.result || "").toString().toLowerCase();
    const won = (e?.won === true) || /win/.test(res);
    const lost = /loss|lose/.test(res);
    const odds = Number(e?.price_snapshot) || Number(e?.odds?.price) || null;
    if (won) { played++; wins++; if (odds) { profit += (odds - 1); avgOdds += odds; } else { profit += 0; } }
    else if (lost) { played++; profit -= 1; if (odds) avgOdds += odds; }
    // pending se preskače
  }
  const roi = played ? (profit / played) : 0;
  const wr = played ? (wins / played) : 0;
  const ao = played ? (avgOdds / played) : 0;
  return { played, wins, profit, roi, winrate: wr, avg_odds: ao };
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const qYmd = String(req.query.ymd||"").trim();
    const ymd = isValidYmd(qYmd) ? qYmd : null;
    if (!ymd) {
      return res.status(200).json({ ok:false, error:"Provide ymd=YYYY-MM-DD" });
    }

    // 1) Primarno: hist:<ymd>
    const histKey = `hist:${ymd}`;
    const { raw:rawHist } = await kvGETraw(histKey, trace);
    let items = filterAllowed(arrFromAny(J(rawHist)));
    let source = items.length ? histKey : null;

    // 2) Fallback: vb:day:<ymd>:combined (filtrirano)
    if (!items.length) {
      const combKey = `vb:day:${ymd}:combined`;
      const { raw:rawComb } = await kvGETraw(combKey, trace);
      items = filterAllowed(arrFromAny(J(rawComb)));
      source = items.length ? combKey : null;
    }

    const kpis = computeROI(items);

    return res.status(200).json({
      ok:true, ymd, source, count: items.length, ...kpis, items,
      debug:{ trace, allowed: Array.from(allowSet) }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
