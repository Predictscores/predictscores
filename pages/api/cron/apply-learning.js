// FILE: pages/api/cron/apply-learning.js
// Selektuje finalnu, "zaključanu" listu iz union pool-a za današnji dan.
// NOVO: BTTS 1st Half (poseban market) — trusted ≥3, EV ≥ 0 (bez relaksa), izuzet iz high-odds guarda.
// Pojačan prioritet za Tier-1 (top lige + UEFA), BEZ ikakvih kvota/ograničenja po broju.
// Guard-ovi: trusted konsenzus, EV (sa CLV-relaksacijom), OU tačno 2.5 (full-time OU), 1 pick po meču,
// high-odds zaštita za BTTS/OU (full-time), stickiness i freeze.
//
// ENV knobs (opciono; svi imaju podrazumevane vrednosti):
//   STICKY_DELTA_PP=3
//   FREEZE_MINUTES=30
//   SLOT_AM_COUNT=15
//   SLOT_PM_COUNT=15
//   SLOT_LATE_COUNT=5
//   SOFT_FLOOR_ENABLE=1
//   EV_FLOOR_RELAXED=-0.02
//   LEARN_MIN_N=50
//   SAFETY_MIN=5
//   MAX_TIER2_ODDS=2.50
//   HIGH_ODDS_BTTS=2.80        // ne važi za BTTS 1H (poseban market)
//   HIGH_ODDS_OU=3.00
//   TIER1_BONUS_PP=1.5
//   TIER2_BONUS_PP=0.5
//   TRUSTED_MIN=2
//   TZ_DISPLAY=Europe/Belgrade

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ---------- KV helpers ----------
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

function ymdToday(tz=TZ){
  return new Intl.DateTimeFormat("sv-SE",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
}
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

// ---- market canonicalization & heuristics ----
function norm(str){ return String(str||"").trim().toUpperCase(); }
function getMarket(p){
  const m = norm(p?.market_label || p?.market);
  // Mapiraj moguće varijante BTTS 1st Half
  if (m.includes("BTTS") && (m.includes("1H") || m.includes("FIRST HALF") || m.includes("1ST HALF") || m.includes("FH"))) {
    return "BTTS 1H";
  }
  if (m === "BOTH TEAMS TO SCORE 1ST HALF") return "BTTS 1H";
  return m;
}
function isBTTS1H(p){ return getMarket(p) === "BTTS 1H"; }
function isBTTS_FT(p){ return getMarket(p) === "BTTS"; }
function isOU_FT(p){ return getMarket(p) === "OU"; } // radimo samo full-time OU

function tierHeuristic(league){
  const name = String(league?.name||"").toLowerCase();
  const country = String(league?.country||"").toLowerCase();
  const t1 = ["premier league","laliga","serie a","bundesliga","ligue 1","eredivisie"];
  if (t1.some(k => name.includes(k))) return 1;
  if (/uefa|champions|europa|conference/.test(name)) return 1;
  if (/(championship|2\. bundesliga|liga ii|i liga|first division|super liga|superliga|jupiler|ligue 2|segunda)/.test(name)) return 2;
  if (/(japan|brazil|argentina|mls)/.test(country)) return 2;
  return 3;
}

// ---------- MAIN ----------
export default async function handler(req,res){
  try{
    // knobs
    const STICKY_DELTA_PP   = Number(process.env.STICKY_DELTA_PP ?? 3);
    const FREEZE_MIN        = Number(process.env.FREEZE_MINUTES ?? 30);

    const targetAM   = Number(process.env.SLOT_AM_COUNT   || 15);
    const targetPM   = Number(process.env.SLOT_PM_COUNT   || 15);
    const targetLATE = Number(process.env.SLOT_LATE_COUNT || 5);

    const SOFT_FLOOR_ENABLE = String(process.env.SOFT_FLOOR_ENABLE ?? "1")==="1";
    const EV_RELAX          = Number(process.env.EV_FLOOR_RELAXED ?? -0.02);
    const LEARN_MIN_N       = Number(process.env.LEARN_MIN_N ?? 50);
    const SAFETY_MIN        = Number(process.env.SAFETY_MIN ?? 5);
    const MAX_TIER2_ODDS    = Number(process.env.MAX_TIER2_ODDS ?? 2.50);
    const HIGH_ODDS_BTTS    = Number(process.env.HIGH_ODDS_BTTS ?? 2.80);
    const HIGH_ODDS_OU      = Number(process.env.HIGH_ODDS_OU   ?? 3.00);
    const TIER1_BONUS_PP    = Number(process.env.TIER1_BONUS_PP ?? 1.5);
    const TIER2_BONUS_PP    = Number(process.env.TIER2_BONUS_PP ?? 0.5);
    const TRUSTED_MIN       = Number(process.env.TRUSTED_MIN ?? 2);

    const ymd = ymdToday(TZ);
    const unionKey = `vb:day:${ymd}:last`;
    const union = toArray(await kvGet(unionKey));
    if (!union.length) return res.status(200).json({ ok:true, updated:false, note:"no union" });

    // learning maps
    const overlayMap = toJSON(await kvGet(`learn:overlay:v1`)) || {};
    const evMinMap   = toJSON(await kvGet(`learn:evmin:v1`))   || {};
    const bucketNMap = toJSON(await kvGet(`learn:bucketN:v1`)) || {};
    const clvAvgMap  = toJSON(await kvGet(`learn:clvavg:v1`))  || {};

    // prethodni final (radi stickiness u okviru meča)
    const prevFinal = toArray(await kvGet(unionKey));
    const prevByFixture = new Map();
    for (const p of prevFinal){
      if (p?.fixture_id) prevByFixture.set(p.fixture_id, p);
    }

    function learnOverlayFor(bkey){
      const n = Number(bucketNMap[bkey]||0);
      if (n < LEARN_MIN_N) return 0;
      const d = Number(overlayMap[bkey] ?? 0);
      if (!Number.isFinite(d)) return 0;
      if (d > 3) return 3;
      if (d < -3) return -3;
      return d;
    }
    function learnEvMinFor(bkey){
      const n = Number(bucketNMap[bkey]||0);
      if (n < LEARN_MIN_N) return 0;
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
      const mkt  = getMarket(p);
      const bkey = bucketKey(mkt, odds, bandTTKOFromNow(ko));
      const delta = learnOverlayFor(bkey);
      let conf = Number(p?.confidence_pct||0) + delta;

      // Pojačan prioritet za Tier-1, blaži za Tier-2
      const tier = tierHeuristic(p?.league);
      if (tier===1) conf += TIER1_BONUS_PP;
      else if (tier===2) conf += TIER2_BONUS_PP;

      const penalty = odds>=3.0 ? 2 : odds>=2.5 ? 1 : 0;
      return { confAdj: conf, score: conf - penalty, bkey, evReq: learnEvMinFor(bkey), ko, odds, tier, mkt };
    }

    // grupiši po fixtureu
    const byFixture = new Map();
    for (const p of union){
      const fid = p?.fixture_id; if (!fid) continue;
      const list = byFixture.get(fid) || [];
      list.push(p);
      byFixture.set(fid, list);
    }

    const baseSelected = [];

    for (const [fid, arr] of byFixture){
      const candidates = [];
      for (const p of arr){
        const trusted = Number(p?.bookmakers_count_trusted||0);
        const odds = Number(p?.market_odds||p?.odds||0);
        const mkt  = getMarket(p);

        // ---- Sanity po marketu ----
        // OU (full-time) mora biti 2.5 (ista linija u selection opisu)
        if (isOU_FT(p)) {
          if (!/2\.5/.test(String(p?.selection||""))) continue;
        }

        // BTTS 1H — POSEBAN MARKET:
        // - izuzet iz generičkog high-odds guarda (1H kvote su prirodno više)
        // - stroži konsenzus i EV: trusted ≥3 i EV ≥ 0 (bez relaksa)
        if (isBTTS1H(p)) {
          if (trusted < 3) continue;
          const ev = Number(p?.ev||0);
          if (!Number.isFinite(ev) || ev < 0) continue; // BEZ relaksa
          // ostalo (stickiness, freeze, rang) radi isto
          const calc = calcScore(p);
          candidates.push({ p, score: calc.score, confAdj: calc.confAdj, ev, koTs: calc.ko ? +calc.ko : Number.MAX_SAFE_INTEGER });
          continue;
        }

        // Ostali marketi: generički high-odds guard (ne primenjuje se na BTTS 1H)
        if (isBTTS_FT(p) && odds>HIGH_ODDS_BTTS && trusted<3) continue;
        if (isOU_FT(p)    && odds>HIGH_ODDS_OU   && trusted<3) continue;

        // Trusted konsenzus (osnovni)
        if (trusted < TRUSTED_MIN) continue;

        // Tier-2 odds "clamp" (disciplinuje srednje lige)
        if (tierHeuristic(p?.league)===2 && odds>MAX_TIER2_ODDS) continue;

        // EV guard po bucketu (sa učenjem)
        const calc = calcScore(p);
        const ev   = Number(p?.ev||0);
        if (!(Number.isFinite(ev) && ev >= calc.evReq)) {
          // relaks samo ako je bucket istorijski pozitivan
          if (!(clvPositive(calc.bkey) && Number.isFinite(ev) && ev >= EV_RELAX)) continue;
        }

        candidates.push({ p, score: calc.score, confAdj: calc.confAdj, ev, koTs: calc.ko ? +calc.ko : Number.MAX_SAFE_INTEGER });
      }
      if (!candidates.length) continue;

      // stickiness prema prethodno izabranom za isti meč
      const prev = prevByFixture.get(fid);
      if (prev){
        const prevCalc = calcScore(prev);
        const prevEV   = Number(prev?.ev||0);
        const nowTs    = Date.now();
        const minsToKO = prevCalc.ko ? Math.round((+prevCalc.ko - nowTs)/60000) : 99999;

        // freeze prozor
        if (minsToKO <= FREEZE_MIN){ baseSelected.push(prev); continue; }

        // da li je "stari" i dalje OK po EV (sa malom tolerancijom)
        const stillEVok = Number.isFinite(prevEV) && prevEV >= (Number(prevCalc.evReq)||0) - 0.03;

        candidates.sort((a,b)=> b.score - a.score || b.ev - a.ev || a.koTs - b.koTs);
        const best = candidates[0];

        if (stillEVok){
          // ne menjaj osim ako novi nije jasno bolji za STICKY_DELTA_PP
          if (best.score < (prevCalc.score + STICKY_DELTA_PP)){ baseSelected.push(prev); continue; }
        }
        baseSelected.push(best.p);
        continue;
      }

      // prvi izbor za ovaj meč
      candidates.sort((a,b)=> b.score - a.score || b.ev - a.ev || a.koTs - b.koTs);
      baseSelected.push(candidates[0].p);
    }

    // sortiranje i sečenje na cilj po slotu (AM/PM/LATE) — Tier-1 nisu kvotirani: ako ih ima 9 dobrih, proći će 9
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

    // SOFT-FLOOR dopuna (ako nema dovoljno) — relaks EV uz pozitivan CLV, važe isti sanity uslovi
    const SOFT_FLOOR_ENABLE = String(process.env.SOFT_FLOOR_ENABLE ?? "1")==="1";
    const EV_RELAX          = Number(process.env.EV_FLOOR_RELAXED ?? -0.02);
    if (SOFT_FLOOR_ENABLE && finalList.length < target){
      const selectedIds = new Set(finalList.map(x=>x.fixture_id));

      function baseSanity(p, trustedMin=TRUSTED_MIN, limitTier2Odds=false){
        const trusted = Number(p?.bookmakers_count_trusted||0);
        const odds = Number(p?.market_odds||p?.odds||0);

        // OU FT mora biti 2.5
        if (isOU_FT(p) && !/2\.5/.test(String(p?.selection||""))) return false;

        // BTTS 1H: poseban sanity — zadržavamo prethodna pravila
        if (isBTTS1H(p)) {
          if (trusted < 3) return false;
          const ev = Number(p?.ev||0);
          if (!Number.isFinite(ev) || ev < 0) return false; // bez relaksa
          return true;
        }

        // generički high-odds guard (ne važi za BTTS 1H)
        if (isBTTS_FT(p) && odds>HIGH_ODDS_BTTS && trusted<trustedMin+1) return false;
        if (isOU_FT(p)    && odds>HIGH_ODDS_OU   && trusted<trustedMin+1) return false;

        if (trusted < trustedMin) return false;
        if (limitTier2Odds && tierHeuristic(p?.league)===2 && odds>MAX_TIER2_ODDS) return false;
        return true;
      }

      const clvAvgMap2 = toJSON(await kvGet(`learn:clvavg:v1`)) || {};

      const pool = [];
      for (const p of union){
        if (selectedIds.has(p.fixture_id)) continue;
        if (!baseSanity(p, TRUSTED_MIN, false)) continue;

        // BTTS 1H već ima stroge uslove i EV≥0 — već prošao
        if (isBTTS1H(p)) { pool.push(p); continue; }

        const ko = parseKO(p);
        const odds = Number(p?.market_odds||p?.odds||0);
        const bkey = bucketKey(getMarket(p), odds, bandTTKOFromNow(ko));
        const ev   = Number(p?.ev||0);
        const evReq = learnEvMinFor(bkey);
        const clvAvg = Number(clvAvgMap2[bkey]);
        const pass = (Number.isFinite(ev) && ev >= evReq) || (Number.isFinite(clvAvg) && clvAvg>0 && Number.isFinite(ev) && ev >= EV_RELAX);
        if (!pass) continue;
        pool.push(p);
      }

      pool.sort((a,b)=>{
        const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
        if (cb!==ca) return cb-ca;
        const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
        if (eb!==ea) return eb-ea;
        return parseKOts(a)-parseKOts(b);
      });

      for (const p of pool){
        if (finalList.length>=target) break;
        finalList.push(p); selectedIds.add(p.fixture_id);
      }
    }

    // Nikad totalno prazno: minimum SAFETY_MIN (konzervativno)
    const SAFETY_MIN = Number(process.env.SAFETY_MIN ?? 5);
    if (finalList.length < SAFETY_MIN){
      const selectedIds = new Set(finalList.map(x=>x.fixture_id));
      const pool = union.filter(p=>{
        if (selectedIds.has(p.fixture_id)) return false;
        const conf = Number(p?.confidence_pct||0);
        const odds = Number(p?.market_odds||p?.odds||0);
        if (isOU_FT(p) && !/2\.5/.test(String(p?.selection||""))) return false;
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
      return (parseKO(a)?.getTime()||9e15) - (parseKO(b)?.getTime()||9e15);
    });

    await kvSet(unionKey, finalList);

    return res.status(200).json({
      ok:true, updated:true,
      n_pool: union.length, n_out: finalList.length,
      note: "Tier-1 bonus + BTTS 1H (trusted≥3, EV≥0, no high-odds guard). Guard-ovi i stickiness aktivni."
    });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
