// FILE: pages/api/cron/refresh-odds.js
// Osvežava kvote/EV/confidence za AM/PM/LATE (mečevi koji startuju ≤3h).
// Histereza: >2% normalno; ≤60' prag 1%; ≤15' uvek osveži.
// Idempotent guard: 60s.

export const config = { api: { bodyParser: false } };

const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

const BASE = "https://v3.football.api-sports.io";
const MIN_ODDS = parseFloat(process.env.MIN_ODDS || "1.5");

const TRUSTED_BOOKIES = (process.env.TRUSTED_BOOKIES || "")
  .split(/[,|]/).map(s=>s.trim().toLowerCase()).filter(Boolean);

const TRUSTED_SPREAD_MAX = parseFloat(process.env.TRUSTED_SPREAD_MAX || "0.12");
const TRUSTED_UPLIFT_CAP = parseFloat(process.env.TRUSTED_UPLIFT_CAP || "0.08");
const ALL_SPREAD_MAX     = parseFloat(process.env.ALL_SPREAD_MAX     || "0.12");
const ONE_TRUSTED_TOL    = parseFloat(process.env.ONE_TRUSTED_TOL    || "0.05");

const REFRESH_WINDOW_HOURS = 3;

/* ---------- KV ---------- */
async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function kvSET(key, value){
  return fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  }).then(r=>r.ok);
}

/* ---------- time ---------- */
function ymdInTZ(d=new Date(), tz=TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}

/* ---------- odds helpers ---------- */
const norm = s => String(s||"").trim().toLowerCase();
function median(values){ if(!values.length)return null; const a=values.slice().sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function impliedFromOdds(o){ return (Number(o)>0)?(1/Number(o)):null; }
function spreadOfImplied(oddsList){
  const imps = oddsList.map(o=>impliedFromOdds(o)).filter(Number.isFinite);
  if (!imps.length) return null;
  const mx = Math.max(...imps), mn = Math.min(...imps);
  if (mn <= 0) return null;
  return (mx - mn);
}

function pickConsensusOdds(pairs){
  // pairs: [{book, odds}]
  if (!pairs || !pairs.length) return null;
  const all = pairs.map(p=>p.odds).filter(Number.isFinite);
  if (!all.length) return null;

  const trusted = pairs
    .filter(p => TRUSTED_BOOKIES.includes(norm(p.book)))
    .map(p => p.odds)
    .filter(Number.isFinite);

  const allSpread = spreadOfImplied(all);
  const trSpread  = spreadOfImplied(trusted);

  // 1) ≥3 trusted i mali spread -> median trusted
  if (trusted.length >= 3 && trSpread != null && trSpread <= TRUSTED_SPREAD_MAX) {
    return { odds: median(trusted), bookmakers_count: all.length, bookmakers_count_trusted: trusted.length, src:"trusted-median" };
  }

  // 2) 1 trusted + ≥5 all, tolerancija prema median(all)
  if (trusted.length === 1 && all.length >= 5) {
    const aMed = median(all);
    const tOnly = trusted[0];
    if (aMed>0 && Math.abs(aMed - tOnly)/tOnly <= ONE_TRUSTED_TOL){
      return { odds:aMed, bookmakers_count:all.length, bookmakers_count_trusted:1, src:"trusted=1+all" };
    }
  }

  // 3) fallback: ≥6 all i mali spread -> median(all)
  if (all.length >= 6 && allSpread != null && allSpread <= ALL_SPREAD_MAX){
    return { odds: median(all), bookmakers_count:all.length, bookmakers_count_trusted:0, src:"all-median" };
  }

  return null;
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
        // 1X2
        if (name.includes("match winner") || name.includes("1x2")){
          for (const v of values){
            const val = String(v?.value||"").toUpperCase();
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (val.includes("HOME")||val==="1") out.oneX2.H.push({book,odds:odd});
            else if (val.includes("DRAW")||val==="X") out.oneX2.D.push({book,odds:odd});
            else if (val.includes("AWAY")||val==="2") out.oneX2.A.push({book,odds:odd});
          }
        }
        // BTTS FT YES
        if (name.includes("both") && name.includes("score") && !name.includes("first half") && !name.includes("1st")){
          for (const v of values){
            const val = String(v?.value||"").toUpperCase();
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (val.includes("YES")) out.bttsYes.push({book,odds:odd});
          }
        }
        // BTTS 1st YES
        if (name.includes("both") && name.includes("score") && (name.includes("first half") || name.includes("1st"))){
          for (const v of values){
            const val = String(v?.value||"").toUpperCase();
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (val.includes("YES")) out.btts1hYes.push({book,odds:odd});
          }
        }
        // OU 2.5 OVER
        if (name.includes("over/under") || name.includes("goals over/under")){
          for (const v of values){
            const label = norm(v?.value||v?.label);
            const line = Number(v?.handicap ?? v?.line ?? (label.includes("2.5")?2.5:NaN));
            const odd = Number(v?.odd||v?.odds||v?.price); if (!Number.isFinite(odd)||odd<=1) continue;
            if (Math.abs(line-2.5)<1e-6 && (label.includes("over")||label==="2.5")){
              out.over25.push({book,odds:odd});
            }
          }
        }
      }
    }
  }
  return out;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res){
  try{
    // idempotent guard 60s
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
      const arr = (()=>{
        const raw = parseMaybe(await kvGET(key));
        return Array.isArray(raw) ? raw : [];
      })();

      function parseMaybe(raw){
        try{
          let v = raw;
          if (typeof v === "string") v = JSON.parse(v);
          if (Array.isArray(v)) return v;
          if (v && typeof v === "object"){
            if (Array.isArray(v.value)) return v.value;
            if (Array.isArray(v.arr)) return v.arr;
            if (Array.isArray(v.data)) return v.data;
            if ("value" in v){
              const inner = v.value;
              if (typeof inner==="string") return JSON.parse(inner);
              if (Array.isArray(inner)) return inner;
            }
          }
        }catch{}
        return [];
      }

      if (!arr.length) continue;

      let updated = 0;
      for (let i=0;i<arr.length;i++){
        const p = arr[i];
        const t = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
        const ms = +new Date(t);
        if (!ms || ms > endMs) continue;   // daleko izvan prozora
        if (ms < nowTime) continue;        // već krenulo

        const mins = Math.round((ms - nowTime)/60000);

        // odds za taj fixture
        let oddsRaw = [];
        try { oddsRaw = await afGet(`/odds?fixture=${p.fixture_id}`); } catch {}
        const ob = collectOddsFromAF(oddsRaw);

        let list = [];
        if (p.market === "1X2"){
          const map = { "1":"H","X":"D","2":"A" };
          list = ob.oneX2[map[String(p.selection).toUpperCase()] || "H"] || [];
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

        // blagi nudge confidence-a
        if (p.bookmakers_count_trusted >= 4) p.confidence_pct = Math.min(85, (p.confidence_pct||0)+1);
        if (p.bookmakers_count_trusted === 0) p.confidence_pct = Math.max(35, (p.confidence_pct||0)-1);

        updated++;
      }

      if (updated>0){
        await kvSET(key, arr);
        updatedTotal += updated;
      }
    }

    // REBUILD :union (NE diramo :last!)
    const union = (()=>{
      function arrOf(k){ return parseMaybe(await kvGET(k)); }
      function parseMaybe(raw){
        try{
          let v = raw;
          if (typeof v === "string") v = JSON.parse(v);
          if (Array.isArray(v)) return v;
          if (v && typeof v === "object"){
            if (Array.isArray(v.value)) return v.value;
            if (Array.isArray(v.arr)) return v.arr;
            if (Array.isArray(v.data)) return v.data;
            if ("value" in v){
              const inner = v.value;
              if (typeof inner==="string") return JSON.parse(inner);
              if (Array.isArray(inner)) return inner;
            }
          }
        }catch{}
        return [];
      }
      function dedupe(...lists){
        const seen=new Set(); const out=[];
        for (const L of lists) for (const it of (L||[])){
          const k = `${it?.fixture_id||""}|${String(it?.market||"")}|${String(it?.selection||"")}`;
          if (seen.has(k)) continue; seen.add(k); out.push(it);
        }
        return out;
      }
      return dedupe(
        await arrOf(`vb:day:${day}:am`),
        await arrOf(`vb:day:${day}:pm`),
        await arrOf(`vb:day:${day}:late`)
      );
    })();
    await kvSET(`vb:day:${day}:union`, await union);

    await kvSET(`vb:jobs:last:refresh-odds`, { ts: nowMs });

    return res.status(200).json({ ok:true, updated:updatedTotal, at:new Date().toISOString() });
  } catch (e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
                }
