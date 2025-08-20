// FILE: pages/api/cron/apply-learning.js
export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

// ---------- KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  try { const js = await r.json(); return js?.result ?? null; } catch { return null; }
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
function toArray(raw){
  try{
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object"){
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v){ const inner=v.value; if (typeof inner==="string") return JSON.parse(inner); if (Array.isArray(inner)) return inner; }
    }
  }catch{}
  return [];
}
function toJSON(raw){ try{ return typeof raw==="string" ? JSON.parse(raw) : raw; }catch{ return null; } }

function parseKO(item){
  const iso = item?.datetime_local?.starting_at?.date_time
           || item?.datetime_local?.date_time
           || item?.time?.starting_at?.date_time
           || null;
  if (!iso) return null;
  const d = new Date(String(iso).replace(" ", "T"));
  return Number.isFinite(+d) ? d : null;
}
function bandOdds(o){
  if (!Number.isFinite(o)) return "UNK";
  if (o<1.8) return "1.50-1.79";
  if (o<2.2) return "1.80-2.19";
  if (o<3.0) return "2.20-2.99";
  return "3.00+";
}
function bandTTKOFromNow(ko){
  if (!ko) return "UNK";
  const mins = Math.round((ko.getTime()-Date.now())/60000);
  if (mins<=180) return "≤3h";
  if (mins<=1440) return "≤24h";
  return ">24h";
}
function bucketKey(market, odds, ttkoBand){
  return `${String(market||"").toUpperCase()}|${bandOdds(odds)}|${ttkoBand}`;
}
function tierHeuristic(league){
  const name = String(league?.name||"").toLowerCase();
  const country = String(league?.country||"").toLowerCase();
  const t1 = ["premier league","laliga","serie a","bundesliga","ligue 1","eredivisie"];
  if (t1.some(k => name.includes(k))) return 1;
  if (/uefa|champions|europa|conference/.test(name)) return 1;
  if (/(championship|2\. bundesliga|liga ii|i liga|first division|super liga|superliga)/.test(name)) return 2;
  if (/(japan|brazil|argentina|mls)/.test(country)) return 2;
  return 3;
}

export default async function handler(req,res){
  try{
    const STICKY_DELTA_PP = Number(process.env.STICKY_DELTA_PP ?? 3); // koliko bolje mora “novi” da bude
    const FREEZE_MIN     = Number(process.env.FREEZE_MINUTES ?? 30);

    const targetAM   = Number(process.env.SLOT_AM_COUNT   || 15);
    const targetPM   = Number(process.env.SLOT_PM_COUNT   || 15);
    const targetLATE = Number(process.env.SLOT_LATE_COUNT || 5);

    const SOFT_FLOOR_ENABLE   = String(process.env.SOFT_FLOOR_ENABLE ?? "1")==="1";
    const EV_RELAX            = Number(process.env.EV_FLOOR_RELAXED ?? -0.02);
    const LEARN_MIN_N         = Number(process.env.LEARN_MIN_N ?? 50);
    const SAFETY_MIN          = Number(process.env.SAFETY_MIN ?? 5);
    const MAX_TIER2_ODDS      = Number(process.env.MAX_TIER2_ODDS ?? 2.50);
    const HIGH_ODDS_BTTS      = Number(process.env.HIGH_ODDS_BTTS ?? 2.80);
    const HIGH_ODDS_OU        = Number(process.env.HIGH_ODDS_OU   ?? 3.00);

    const ymd = new Intl.DateTimeFormat("sv-SE",{ timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
    const unionKey = `vb:day:${ymd}:last`;
    const union = toArray(await kvGet(unionKey));
    if (!union.length) return res.status(200).json({ ok:true, updated:false, note:"no union" });

    // learning maps
    const overlayMap = toJSON(await kvGet(`learn:overlay:v1`)) || {};
    const evMinMap   = toJSON(await kvGet(`learn:evmin:v1`))   || {};
    const bucketNMap = toJSON(await kvGet(`learn:bucketN:v1`)) || {};
    const clvAvgMap  = toJSON(await kvGet(`learn:clvavg:v1`))  || {};

    // prethodni final (radi stickiness u okviru slota)
    const prevFinal = toArray(await kvGet(unionKey));
    const prevByFixture = new Map();
    for (const p of prevFinal){
      if (p?.fixture_id) prevByFixture.set(p.fixture_id, p);
    }

    function learnOverlayFor(bkey){
      const n = Number(bucketNMap[bkey]||0);
      if (n < LEARN_MIN_N) return 0; // gating
      const d = Number(overlayMap[bkey] ?? 0);
      if (!Number.isFinite(d)) return 0;
      if (d > 3) return 3;
      if (d < -3) return -3;
      return d;
    }
    function learnEvMinFor(bkey){
      const n = Number(bucketNMap[bkey]||0);
      if (n < LEARN_MIN_N) return 0; // gating
      const v = Number(evMinMap[bkey] ?? 0);
      return Number.isFinite(v) ? v : 0;
    }
    function clvPositive(bkey){
      const v = Number(clvAvgMap[bkey]);
      return Number.isFinite(v) && v > 0;
    }

    function calcScore(p){
      const ko = parseKO(p);
      const odds = Number(p?.market_odds||p?.odds||0);
      const bkey = bucketKey(p?.market, odds, bandTTKOFromNow(ko));
      const delta = learnOverlayFor(bkey);
      const conf = Number(p?.confidence_pct||0) + delta;
      const penalty = odds>=3.0 ? 2 : odds>=2.5 ? 1 : 0;
      const tier = tierHeuristic(p?.league);
      const bonusTier = tier===1 ? 1 : tier===2 ? 0.5 : 0;
      return { confAdj: conf, score: conf - penalty + bonusTier, bkey, evReq: learnEvMinFor(bkey), ko, odds, tier };
    }

    const TRUSTED_MIN = 2;

    // grupiši po fixtureu
    const byFixture = new Map();
    for (const p of union){
      const fid = p?.fixture_id; if (!fid) continue;
      const list = byFixture.get(fid) || [];
      list.push(p);
      byFixture.set(fid, list);
    }

    // bazni izbor (strogi filteri)
    const baseSelected = [];
    const tried = new Set();

    for (const [fid, arr] of byFixture){
      const candidates = [];
      for (const p of arr){
        const trusted = Number(p?.bookmakers_count_trusted||0);
        if (trusted < TRUSTED_MIN) continue;

        if (String(p?.market||"").toUpperCase()==="OU"){
          if (!/2\.5/.test(String(p?.selection||""))) continue;
        }

        const odds = Number(p?.market_odds||p?.odds||0);
        if (String(p?.market||"").toUpperCase()==="BTTS" && odds>HIGH_ODDS_BTTS && trusted<3) continue;
        if (String(p?.market||"").toUpperCase()==="OU"   && odds>HIGH_ODDS_OU   && trusted<3) continue;

        const { confAdj, score, bkey, evReq, ko } = calcScore(p);
        const ev = Number(p?.ev||0);
        if (!(Number.isFinite(ev) && ev >= evReq)) continue;

        candidates.push({ p, score, confAdj, ev, koTs: ko ? +ko : Number.MAX_SAFE_INTEGER, bkey });
      }
      if (!candidates.length) continue;

      // stickiness: ako prethodni izbor i dalje kandidat, zadrži ga osim ako novi nije značajno bolji
      const prev = prevByFixture.get(fid);
      if (prev){
        const prevCalc = calcScore(prev);
        const prevEV   = Number(prev?.ev||0);
        const nowTs    = Date.now();
        const minsToKO = prevCalc.ko ? Math.round((+prevCalc.ko - nowTs)/60000) : 99999;

        if (minsToKO <= FREEZE_MIN){ baseSelected.push(prev); tried.add(fid); continue; }

        const stillEVok = Number.isFinite(prevEV) && prevEV >= (Number(prevCalc.evReq)||0) - 0.03;

        candidates.sort((a,b)=> b.score - a.score || b.ev - a.ev || a.koTs - b.koTs);
        const best = candidates[0];

        if (stillEVok){
          if (best.score < (prevCalc.score + STICKY_DELTA_PP)){ baseSelected.push(prev); tried.add(fid); continue; }
        }
        baseSelected.push(best.p);
        tried.add(fid);
        continue;
      }

      candidates.sort((a,b)=> b.score - a.score || b.ev - a.ev || a.koTs - a.koTs);
      baseSelected.push(candidates[0].p);
      tried.add(fid);
    }

    // sortiranje i target po slotu
    function parseKOts(p){ const d=parseKO(p); return d? +d : Number.MAX_SAFE_INTEGER; }
    baseSelected.sort((a,b)=>{
      const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
      if (cb!==ca) return cb-ca;
      const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
      if (eb!==ea) return eb-ea;
      return parseKOts(a)-parseKOts(b);
    });

    const hour = Number(new Intl.DateTimeFormat("en-GB",{ timeZone: TZ, hour:"2-digit", hour12:false }).format(new Date()));
    const target = (hour>=15) ? targetPM : (hour<3 ? targetLATE : targetAM);

    let finalList = baseSelected.slice(0, Math.max(1, target));

    // ---------- SOFT FLOOR (ako nema dovoljno)
    if (SOFT_FLOOR_ENABLE && finalList.length < target){
      const selectedIds = new Set(finalList.map(x=>x.fixture_id));

      // Helper: može li p da prođe OU i high-odds guard (blaže re-uses)
      function baseSanity(p, trustedMin=2, limitTier2Odds=false){
        const trusted = Number(p?.bookmakers_count_trusted||0);
        if (trusted < trustedMin) return false;

        if (String(p?.market||"").toUpperCase()==="OU"){
          if (!/2\.5/.test(String(p?.selection||""))) return false;
        }
        const odds = Number(p?.market_odds||p?.odds||0);
        if (String(p?.market||"").toUpperCase()==="BTTS" && odds>HIGH_ODDS_BTTS && trusted<trustedMin+1) return false;
        if (String(p?.market||"").toUpperCase()==="OU"   && odds>HIGH_ODDS_OU   && trusted<trustedMin+1) return false;
        if (limitTier2Odds && odds>MAX_TIER2_ODDS) return false;
        return true;
      }

      // STEP 1: EV relaksacija (EV ≥ EV_RELAX) za buckete sa pozitivnim CLV
      const step1 = [];
      for (const p of union){
        if (selectedIds.has(p.fixture_id)) continue;
        const ko = parseKO(p);
        const odds = Number(p?.market_odds||p?.odds||0);
        const bkey = bucketKey(p?.market, odds, bandTTKOFromNow(ko));
        if (!clvPositive(bkey)) continue;

        if (!baseSanity(p, 2, false)) continue;

        const ev = Number(p?.ev||0);
        if (!(Number.isFinite(ev) && ev >= EV_RELAX)) continue;

        step1.push(p);
      }
      step1.sort((a,b)=>{
        const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
        if (cb!==ca) return cb-ca;
        const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
        if (eb!==ea) return eb-ea;
        return parseKOts(a)-parseKOts(b);
      });
      for (const p of step1){
        if (finalList.length>=target) break;
        finalList.push(p); selectedIds.add(p.fixture_id);
      }

      // STEP 2: Tier-1 fallback (trusted ≥1), zadrži bazne sanity uslove
      if (finalList.length < target){
        const step2=[];
        for (const p of union){
          if (selectedIds.has(p.fixture_id)) continue;
          if (tierHeuristic(p?.league)!==1) continue;
          if (!baseSanity(p, 1, false)) continue;
          const ev = Number(p?.ev||0);
          if (!(Number.isFinite(ev) && ev >= EV_RELAX)) continue;
          step2.push(p);
        }
        step2.sort((a,b)=>{
          const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
          if (cb!==ca) return cb-ca;
          const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
          if (eb!==ea) return eb-ea;
          return parseKOts(a)-parseKOts(b);
        });
        for (const p of step2){
          if (finalList.length>=target) break;
          finalList.push(p); selectedIds.add(p.fixture_id);
        }
      }

      // STEP 3: Tier-2 fallback (trusted ≥1, odds ≤ MAX_TIER2_ODDS)
      if (finalList.length < target){
        const step3=[];
        for (const p of union){
          if (selectedIds.has(p.fixture_id)) continue;
          if (tierHeuristic(p?.league)!==2) continue;
          if (!baseSanity(p, 1, true)) continue;
          const ev = Number(p?.ev||0);
          if (!(Number.isFinite(ev) && ev >= EV_RELAX)) continue;
          step3.push(p);
        }
        step3.sort((a,b)=>{
          const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
          if (cb!==ca) return cb-ca;
          const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
          if (eb!==ea) return eb-ea;
          return parseKOts(a)-parseKOts(b);
        });
        for (const p of step3){
          if (finalList.length>=target) break;
          finalList.push(p); selectedIds.add(p.fixture_id);
        }
      }
    }

    // Nikad prazno: minimum SAFETY_MIN (blagi uslovi, fokus na conf)
    if (finalList.length < SAFETY_MIN){
      const selectedIds = new Set(finalList.map(x=>x.fixture_id));
      const pool = union.filter(p=>{
        if (selectedIds.has(p.fixture_id)) return false;
        const conf = Number(p?.confidence_pct||0);
        const odds = Number(p?.market_odds||p?.odds||0);
        // bazni limiti
        if (String(p?.market||"").toUpperCase()==="OU" && !/2\.5/.test(String(p?.selection||""))) return false;
        if (odds<1.5 || odds>2.8) return false;
        return conf>=70;
      });
      pool.sort((a,b)=>{
        const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
        if (cb!==ca) return cb-ca;
        const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
        if (eb!==ea) return eb-ea;
        return parseKOts(a)-parseKOts(b);
      });
      for (const p of pool){
        if (finalList.length>=SAFETY_MIN) break;
        finalList.push(p);
      }
    }

    // Final sort (stabilno)
    finalList.sort((a,b)=>{
      const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
      if (cb!==ca) return cb-ca;
      const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
      if (eb!==ea) return eb-ea;
      return parseKOts(a)-parseKOts(b);
    });

    await kvSet(unionKey, finalList);

    return res.status(200).json({
      ok:true, updated:true,
      n_in: union.length, n_out: finalList.length,
      gating_minN: LEARN_MIN_N,
      used_soft_floor: finalList.length < Math.max(1, (hour>=15)?targetPM: (hour<3?targetLATE:targetAM)) ? 1 : 0
    });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
