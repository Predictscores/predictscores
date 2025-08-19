// pages/api/cron/refresh-odds.js
// Osvežava kvote/EV/confidence za AM/PM/LATE (mečevi koji startuju ≤3h).
// Histereza: >2% normalno; ≤60' prag 1%; ≤15' uvek osveži.
// Idempotent guard: 60s.

export const config = { api: { bodyParser: false } };

const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const BASE = "https://v3.football.api-sports.io";
const MIN_ODDS = parseFloat(process.env.MIN_ODDS || "1.5");

const TRUSTED_BOOKIES = (process.env.TRUSTED_BOOKIES || "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
const TRUSTED_SPREAD_MAX = parseFloat(process.env.TRUSTED_SPREAD_MAX || "0.12");
const TRUSTED_UPLIFT_CAP = parseFloat(process.env.TRUSTED_UPLIFT_CAP || "0.08");
const ALL_SPREAD_MAX     = parseFloat(process.env.ALL_SPREAD_MAX || "0.12");
const ONE_TRUSTED_TOL    = parseFloat(process.env.ONE_TRUSTED_TOL || "0.05");

const REFRESH_WINDOW_HOURS = 3;

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d);
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
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
function parseArray(raw){
  try{
    let v = raw;
    if (typeof v==="string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v==="object"){
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v) {
        const inner = v.value;
        if (typeof inner==="string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}
function dedupeUnion(...lists){
  const map = new Map();
  for (const L of lists){
    for (const p of (L||[])){
      const id = p?.fixture_id ?? `${p?.league?.id||""}-${p?.teams?.home?.name||""}-${p?.teams?.away?.name||""}`;
      if (!map.has(id)) map.set(id, p);
    }
  }
  return Array.from(map.values());
}

const norm = s => String(s||"").trim().toLowerCase();
function median(values){ if(!values.length)return null; const a=values.slice().sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function spreadRatio(values){ if(!values.length)return null; const mx=Math.max(...values), mn=Math.min(...values); if(mn<=0)return null; return (mx/mn)-1; }
function pickConsensusOdds(list){
  const all = list.map(x=>x.odds);
  if (!all.length) return null;
  const trusted = list.filter(x=>TRUSTED_BOOKIES.includes(x.book)).map(x=>x.odds);
  const trustedCount = trusted.length;
  const allSpread = spreadRatio(all);
  if (trustedCount >= 2){
    const tSpread = spreadRatio(trusted);
    if (tSpread!=null && tSpread <= TRUSTED_SPREAD_MAX){
      const tMed = median(trusted);
      const tMax = Math.max(...trusted);
      const capped = Math.min(tMax, tMed*(1+TRUSTED_UPLIFT_CAP));
      return { odds:capped, src:"trusted≥2", bookmakers_count:all.length, bookmakers_count_trusted:trustedCount };
    }
    return null;
  }
  if (trustedCount === 1){
    const tOnly = trusted[0];
    const aMed = median(all);
    if (aMed && Math.abs(aMed - tOnly)/tOnly <= ONE_TRUSTED_TOL){
      return { odds:aMed, src:"trusted=1+all", bookmakers_count:all.length, bookmakers_count_trusted:1 };
    }
    return null;
  }
  if (all.length >= 6 && allSpread!=null && allSpread <= ALL_SPREAD_MAX){
    return { odds:median(all), src:"all-median", bookmakers_count:all.length, bookmakers_count_trusted:0 };
  }
  return null;
}
function collectOddsFromAF(oddsResponse){
  const out = { oneX2:{H:[],D:[],A:[]}, bttsYes:[], btts1hYes:[], over25:[] };
  for (const item of oddsResponse||[]){
    const bms = item?.bookmakers || [];
    for (const bm of bms){
      const book = norm(bm?.name);
      const bets = bm?.bets || [];
      for (const bet of bets){
        const name = norm(bet?.name);
        const values = bet?.values || [];
        if (name.includes("match winner") || name.includes("1x2")){
          for (const v of values){
            const val = String(v?.value||"").toUpperCase();
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (val.includes("HOME")||val==="1") out.oneX2.H.push({book,odds:odd});
            else if (val.includes("DRAW")||val==="X") out.oneX2.D.push({book,odds:odd});
            else if (val.includes("AWAY")||val==="2") out.oneX2.A.push({book,odds:odd});
          }
        }
        if (name.includes("both") && name.includes("score") && !name.includes("first half") && !name.includes("1st")){
          for (const v of values){
            const val = String(v?.value||"").toUpperCase();
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (val.includes("YES")) out.bttsYes.push({book,odds:odd});
          }
        }
        if (name.includes("both") && name.includes("score") && (name.includes("first half") || name.includes("1st"))){
          for (const v of values){
            const val = String(v?.value||"").toUpperCase();
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (val.includes("YES")) out.btts1hYes.push({book,odds:odd});
          }
        }
        if (name.includes("over/under") || name.includes("goals over/under")){
          for (const v of values){
            const label = norm(v?.value||v?.label);
            const line = Number(v?.handicap ?? v?.line ?? (label.includes("2.5")?2.5:NaN));
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (Math.abs(line-2.5)<1e-6 && (label.includes("over")||label.includes("over 2.5")||label==="2.5")){
              out.over25.push({book,odds:odd});
            }
          }
        }
      }
    }
  }
  return out;
}
function impliedFromOdds(o){ return (Number(o)>0)?(1/Number(o)):null; }

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

export default async function handler(req, res){
  try{
    // guard 60s
    const lastRunRaw = await kvGET(`vb:jobs:last:refresh-odds`);
    const nowMs = Date.now();
    try{
      const last = (typeof lastRunRaw==="string") ? JSON.parse(lastRunRaw) : lastRunRaw;
      if (last && nowMs - Number(last?.ts||0) < 60_000) {
        return res.status(200).json({ ok:true, skipped:true, reason:"cooldown" });
      }
    }catch{}

    const day = ymdInTZ(new Date(), TZ);

    const slotKeys = [
      `vb:day:${day}:am`,
      `vb:day:${day}:pm`,
      `vb:day:${day}:late`
    ];

    const now = new Date();
    const nowTime = now.getTime();
    const endMs = nowTime + REFRESH_WINDOW_HOURS*3600*1000;

    let updatedTotal = 0;

    for (const key of slotKeys){
      const arr = parseArray(await kvGET(key));
      if (!arr.length) continue;

      let updated = 0;
      for (let i=0;i<arr.length;i++){
        const p = arr[i];
        const t = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
        const ms = +new Date(t);
        if (!ms || ms > endMs) continue;
        if (ms < nowTime) continue;

        const mins = Math.round((ms - nowTime)/60000);

        const oddsRaw = await afGet(`/odds?fixture=${p.fixture_id}`);
        const ob = collectOddsFromAF(oddsRaw);

        let list = [];
        if (p.market === "1X2"){
          const map = { "1":"H","X":"D","2":"A" };
          list = ob.oneX2[map[p.selection] || "H"] || [];
        } else if (p.market === "BTTS"){
          list = ob.bttsYes;
        } else if (p.market === "BTTS 1H"){
          list = ob.btts1hYes;
        } else if (p.market === "OU" && String(p.selection).toUpperCase().includes("OVER")){
          list = ob.over25;
        } else {
          continue;
        }

        const cns = pickConsensusOdds(list);
        if (!cns || !Number.isFinite(cns.odds) || cns.odds < MIN_ODDS) continue;

        const oldOdds = Number(p.market_odds);
        if (!Number.isFinite(oldOdds) || oldOdds<=0) continue;

        // histereza: 2% default, 1% ≤60', uvek ≤15'
        const rel = Math.abs(cns.odds - oldOdds) / oldOdds;
        const bkDelta = Math.abs(Number(p.bookmakers_count||0) - Number(cns.bookmakers_count||0));
        const th = (mins <= 15) ? -1 : (mins <= 60) ? 0.01 : 0.02;

        if (th >= 0 && rel <= th && bkDelta < 2) continue;

        const implied = impliedFromOdds(cns.odds);
        const mp = Number(p?.model_prob || 0);
        const evRatio = (implied && mp>0) ? (mp / implied - 1) : null;

        p.market_odds = Number(cns.odds.toFixed(2));
        p.implied_prob = implied;
        p.ev = evRatio;
        p.edge = evRatio;
        p.edge_pp = (evRatio!=null) ? ((mp - implied) * 100) : p.edge_pp;
        p.bookmakers_count = Number(cns.bookmakers_count||0);
        p.bookmakers_count_trusted = Number(cns.bookmakers_count_trusted||0);

        if (p.bookmakers_count_trusted >= 4) p.confidence_pct = Math.min(85, (p.confidence_pct||0)+1);
        if (p.bookmakers_count_trusted === 0) p.confidence_pct = Math.max(35, (p.confidence_pct||0)-1);

        updated++;
      }

      if (updated>0){
        await kvSET(key, arr);
        updatedTotal += updated;
      }
    }

    // UNION update
    const union = dedupeUnion(
      parseArray(await kvGET(`vb:day:${day}:am`)),
      parseArray(await kvGET(`vb:day:${day}:pm`)),
      parseArray(await kvGET(`vb:day:${day}:late`))
    );
    if (union.length){
      await kvSET(`vb:day:${day}:last`, union);
      await kvSET(`vb:day:${ymdInTZ(new Date(), "UTC")}:last`, union);
    }
    await kvSET(`vb:jobs:last:refresh-odds`, { ts: nowMs });

    return res.status(200).json({ ok:true, updated:updatedTotal, at:new Date().toISOString() });
  } catch (e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
