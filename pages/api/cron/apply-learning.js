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
    const FREEZE_MIN = Number(process.env.FREEZE_MINUTES ?? 30);

    const targetAM   = Number(process.env.SLOT_AM_COUNT   || 15);
    const targetPM   = Number(process.env.SLOT_PM_COUNT   || 15);
    const targetLATE = Number(process.env.SLOT_LATE_COUNT || 5);

    const ymd = new Intl.DateTimeFormat("sv-SE",{ timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit"}).format(new Date());
    const unionKey = `vb:day:${ymd}:last`;
    const union = toArray(await kvGet(unionKey));
    if (!union.length) return res.status(200).json({ ok:true, updated:false, note:"no union" });

    const overlayMap = toJSON(await kvGet(`learn:overlay:v1`)) || {};
    const evMinMap   = toJSON(await kvGet(`learn:evmin:v1`))   || {};

    const TRUSTED_MIN = 2;
    const HIGH_ODDS_BTTS = Number(process.env.HIGH_ODDS_BTTS ?? 2.80);
    const HIGH_ODDS_OU   = Number(process.env.HIGH_ODDS_OU   ?? 3.00);

    // raniji final (radi stickiness)
    const prevFinal = toArray(await kvGet(unionKey));
    const prevByFixture = new Map();
    for (const p of prevFinal){
      if (p?.fixture_id) prevByFixture.set(p.fixture_id, p);
    }

    // grupiši po fixtureu
    const byFixture = new Map();
    for (const p of union){
      const fid = p?.fixture_id; if (!fid) continue;
      const list = byFixture.get(fid) || [];
      list.push(p);
      byFixture.set(fid, list);
    }

    function calcScore(p){
      const ko = parseKO(p);
      const odds = Number(p?.market_odds||p?.odds||0);
      const bkey = bucketKey(p?.market, odds, bandTTKOFromNow(ko));
      const delta = Number(overlayMap[bkey] ?? 0);
      const conf = Number(p?.confidence_pct||0) + delta;
      const penalty = odds>=3.0 ? 2 : odds>=2.5 ? 1 : 0;
      const tier = tierHeuristic(p?.league);
      const bonusTier = tier===1 ? 1 : tier===2 ? 0.5 : 0;
      return { confAdj: conf, score: conf - penalty + bonusTier, bkey, evReq: Number(evMinMap[bkey] ?? 0), ko };
    }

    const selected = [];
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

        candidates.push({ p, score, confAdj, ev, koTs: ko ? +ko : Number.MAX_SAFE_INTEGER, bkey, evReq });
      }
      if (!candidates.length) continue;

      // stickiness: ako prethodni izbor i dalje kandidat, zadrži ga osim ako novi nije značajno bolji
      const prev = prevByFixture.get(fid);
      if (prev){
        const prevCalc = calcScore(prev);
        const prevEV   = Number(prev?.ev||0);
        const nowTs    = Date.now();
        const minsToKO = prevCalc.ko ? Math.round((+prevCalc.ko - nowTs)/60000) : 99999;

        // ako smo u freeze zoni, zadrži prethodni bezuslovno
        if (minsToKO <= FREEZE_MIN){
          selected.push(prev);
          continue;
        }

        // da li prev i dalje prolazi EV prag (uz malu toleranciju −0.03)?
        const stillEVok = Number.isFinite(prevEV) && prevEV >= (Number(prevCalc.evReq)||0) - 0.03;

        // najbolji novi kandidat
        candidates.sort((a,b)=> b.score - a.score || b.ev - a.ev || a.koTs - b.koTs);
        const best = candidates[0];

        if (stillEVok){
          // zadrži ako novi nije “STICKY_DELTA_PP” bolji po konf. skoru
          if (best.score < (prevCalc.score + STICKY_DELTA_PP)){
            selected.push(prev);
            continue;
          }
        }
        // inače dozvoli zamenu
        selected.push(best.p);
        continue;
      }

      // bez prethodnog izbora: izaberi najboljeg
      candidates.sort((a,b)=> b.score - a.score || b.ev - a.ev || a.koTs - b.koTs);
      selected.push(candidates[0].p);
    }

    // Sortiranje: conf desc → EV desc → kickoff asc
    function parseKOts(p){ const d=parseKO(p); return d? +d : Number.MAX_SAFE_INTEGER; }
    selected.sort((a,b)=>{
      const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
      if (cb!==ca) return cb-ca;
      const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
      if (eb!==ea) return eb-ea;
      return parseKOts(a)-parseKOts(b);
    });

    // Trim po slotu (po lokalnom satu)
    const hour = Number(new Intl.DateTimeFormat("en-GB",{ timeZone: TZ, hour:"2-digit", hour12:false }).format(new Date()));
    const weekday = Number(new Intl.DateTimeFormat("en-GB",{ timeZone: TZ, weekday:"short"}).format(new Date()).toLowerCase().startsWith("s")); // 1 vikend? (ne koristimo, ali ostavljeno)
    const target = (hour>=15) ? targetPM : (hour<3 ? targetLATE : targetAM);
    const finalList = selected.slice(0, Math.max(1, target));

    await kvSet(unionKey, finalList);

    return res.status(200).json({
      ok:true, updated:true,
      n_in: union.length, n_out: finalList.length,
      slot_target: target
    });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
