// pages/api/cron/learn.js
// Noćni learning: poredi jučerašnji snapshot vs ishodi i pravi overlay (±1–3pp).
// Jeftino, bez promena UI-a.

export const config = { api: { bodyParser: false } };

const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const BASE = "https://v3.football.api-sports.io";

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d); // YYYY-MM-DD
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function addDays(dateStr, delta){
  const d = new Date(dateStr+"T00:00:00Z");
  d.setUTCDate(d.getUTCDate()+delta);
  return d.toISOString().slice(0,10);
}

async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function kvSET(key, value){
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  let js=null; try{ js=await r.json(); }catch{}
  return { ok:r.ok, js };
}
async function afGet(path) {
  const key =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, "x-rapidapi-key": key },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

function parseSnapshot(raw){
  try{
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v==="object") {
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner === "string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}

function outcomeForPick(pick, fxDetail){
  // fxDetail: from /fixtures?id=..., expects score.{fulltime, halftime}
  const ft = fxDetail?.score?.fulltime || fxDetail?.score || {};
  const ht = fxDetail?.score?.halftime || {};
  const hFT = Number(ft.home ?? fxDetail?.goals?.home ?? 0);
  const aFT = Number(ft.away ?? fxDetail?.goals?.away ?? 0);
  const hHT = Number(ht.home ?? 0);
  const aHT = Number(ht.away ?? 0);

  if (pick.market === "1X2") {
    const res = (hFT>aFT) ? "1" : (hFT===aFT) ? "X" : "2";
    return res === pick.selection;
  }
  if (pick.market === "BTTS") {
    return (hFT>=1 && aFT>=1);
  }
  if (pick.market === "BTTS 1H") {
    return (hHT>=1 && aHT>=1);
  }
  if (pick.market === "OU") {
    // selection "OVER 2.5"
    return (hFT + aFT) > 2;
  }
  if (pick.market === "HT-FT") {
    const htRes = (hHT>aHT) ? "H" : (hHT===aHT) ? "D" : "A";
    const ftRes = (hFT>aFT) ? "H" : (hFT===aFT) ? "D" : "A";
    return `${htRes}/${ftRes}` === pick.selection;
  }
  return null;
}

export default async function handler(req, res){
  try{
    const today = ymdInTZ(new Date(), TZ);
    const yday = addDays(today, -1);

    const raw = await kvGET(`vb:day:${yday}:last`);
    const arr = parseSnapshot(raw);
    if (!arr.length) return res.status(200).json({ ok:true, note:"no snapshot" });

    // Povuci detalje za sve unikantne fixture_id (batched loop)
    const ids = Array.from(new Set(arr.map(p=>p.fixture_id).filter(Boolean)));
    const details = new Map();
    for (const id of ids) {
      const r = await afGet(`/fixtures?id=${id}`);
      const d = Array.isArray(r) ? r[0] : null;
      if (d) details.set(id, d);
    }

    // Agregacija per (leagueId, market)
    const agg = {}; // { [leagueId]: { [market]: { n, won, roiSum, trustedAvg, confAvg } } }
    for (const p of arr) {
      const det = details.get(p.fixture_id);
      if (!det) continue;
      const isDone = String(det?.fixture?.status?.short||"").toUpperCase() === "FT";
      if (!isDone) continue;

      const leagueId = String(p?.league?.id || "0");
      const market = String(p?.market || "UNK");

      const won = outcomeForPick(p, det);
      if (won == null) continue;

      const odds = Number(p?.market_odds || 0);
      const roi = won ? (odds - 1) : -1;

      agg[leagueId] = agg[leagueId] || {};
      agg[leagueId][market] = agg[leagueId][market] || { n:0, won:0, roiSum:0, confSum:0, depthSum:0 };
      const a = agg[leagueId][market];
      a.n += 1;
      a.won += won ? 1 : 0;
      a.roiSum += roi;
      a.confSum += Number(p?.confidence_pct || 0);
      a.depthSum += Number(p?.bookmakers_count_trusted || 0);
    }

    // Overlay pravila: ako ROI>> +2/3pp, ako ROI<< -2/3pp (po ligi/marketu)
    const overlay = {};
    Object.entries(agg).forEach(([leagueId, markets])=>{
      Object.entries(markets).forEach(([market, a])=>{
        const roi = a.roiSum / Math.max(1, a.n); // ROI po ulogu
        let delta = 0;
        if (roi >= 0.05) delta = +2;
        else if (roi >= 0.02) delta = +1;
        else if (roi <= -0.05) delta = -2;
        else if (roi <= -0.02) delta = -1;
        if (delta !== 0) {
          overlay[leagueId] = overlay[leagueId] || {};
          overlay[leagueId][market] = delta; // u pp
        }
      });
    });

    await kvSET(`learn:overlay:${yday}`, overlay);
    await kvSET(`learn:overlay:current`, overlay);

    return res.status(200).json({ ok:true, day:yday, overlay, agg });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
