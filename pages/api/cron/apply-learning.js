// pages/api/cron/apply-learning.js
// FINAL list builder: uzima SAMO aktivni slot (AM / PM / LATE),
// odbacuje već-startovane mečeve, popravljen freeze (važi samo pre KO),
// i snima final u vb:day:<YMD>:last da UI vidi čistu listu.
//
// Ne menja UI izgled. Radi sa postojećim rebuild/insights/learning koracima.

export const config = { api: { bodyParser: false } };

// ---------- KV helpers ----------
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  try {
    const { result } = await r.json();
    return result ?? null;
  } catch {
    return null;
  }
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

// ---------- small utils ----------
function toJSON(v){ try { return typeof v==="string" ? JSON.parse(v) : v; } catch { return null; } }
function toArray(v){
  const j = toJSON(v);
  if (Array.isArray(j)) return j;
  if (j && typeof j==="object"){
    if (Array.isArray(j.value)) return j.value;
    if (Array.isArray(j.arr)) return j.arr;
    if (Array.isArray(j.data)) return j.data;
  }
  return [];
}

function ymdToday(tz = "Europe/Belgrade"){
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(new Date());
}

function parseKO(p){
  const iso = p?.datetime_local?.starting_at?.date_time
           || p?.datetime_local?.date_time
           || p?.time?.starting_at?.date_time
           || null;
  if (!iso) return null;
  try { return new Date(String(iso).replace(" ", "T")); } catch { return null; }
}

function getMarket(p){
  const m = String(p?.market_label || p?.market || "").toUpperCase();
  if (m.includes("BTTS") && m.includes("1H")) return "BTTS 1H";
  if (m.includes("BTTS")) return "BTTS";
  if (m.includes("OVER") || m === "OU") return "OU";
  if (m.includes("HT/FT")) return "HTFT";
  return "1X2";
}

function isBTTS1H(p){ return getMarket(p) === "BTTS 1H"; }
function isBTTS_FT(p){ return getMarket(p) === "BTTS"; }
function isOU_FT(p){ return getMarket(p) === "OU"; }

function minutesToKO(p){
  const d = parseKO(p);
  if (!d) return 999999;
  return Math.round((+d - Date.now())/60000);
}

function tierHeuristic(league){
  const name = String(league?.name || "").toLowerCase();
  const country = String(league?.country || "").toLowerCase();
  const t1 = [
    "premier league","epl","la liga","laliga","serie a","bundesliga",
    "ligue 1","eredivisie","primera division","champions league","uefa champions league",
    "europa league","uefa europa league","conference league"
  ];
  if (t1.some(s => name.includes(s))) return 1;
  const t2 = ["championship","primeira liga","super lig","superliga","mls","j1 league","ligue 2","2. bundesliga","serie b","laliga2","segunda","eredivisie2"];
  if (t2.some(s => name.includes(s))) return 2;
  return 3;
}

function currentSlot(tz = "Europe/Belgrade"){
  const h = Number(new Intl.DateTimeFormat("en-GB",{ timeZone: tz, hour:"2-digit", hour12:false }).format(new Date()));
  if (h >= 0 && h < 3) return "late";
  if (h >= 10 && h < 15) return "am";
  if (h >= 15 && h <= 23) return "pm";
  // fallback: koristi PM poslepodne
  return (h >= 3 && h < 10) ? "am" : "pm";
}

// ---------- handler ----------
export default async function handler(req, res){
  try{
    const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

    // param za debug/testing (?slot=am|pm|late)
    const slotParam = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(slotParam) ? slotParam : currentSlot(TZ);

    const ymd = ymdToday(TZ);

    // 1) izvor: SAMO aktivni slot (čisti AM u 15h itd). fallback na union/last ako slot nema ništa.
    const slotKey = `vb:day:${ymd}:${slot}`;
    let pool = toArray(await kvGet(slotKey));

    if (!pool.length){
      // fallback: probaj union; ako nema, probaj last
      const unionKeyTry = `vb:day:${ymd}:union`;
      pool = toArray(await kvGet(unionKeyTry));
      if (!pool.length){
        const lastKeyTry = `vb:day:${ymd}:last`;
        pool = toArray(await kvGet(lastKeyTry));
      }
    }

    if (!pool.length){
      await kvSet(`vb:day:${ymd}:last`, []); // očisti da UI ne pokazuje stare
      return res.status(200).json({ ok:true, updated:false, note:"empty pool", slot });
    }

    // 2) DROP started: ne dozvoli da uđu mečevi koji su već krenuli
    const poolNotStarted = pool.filter(p => minutesToKO(p) > 0);

    if (!poolNotStarted.length){
      await kvSet(`vb:day:${ymd}:last`, []);
      return res.status(200).json({ ok:true, updated:true, written:0, slot, note:"all started -> emptied" });
    }

    // 3) priprema za stickiness: prethodni final
    const finalKey = `vb:day:${ymd}:last`;
    const prevFinal = toArray(await kvGet(finalKey));
    const prevByFixture = new Map();
    for (const x of prevFinal){
      if (x?.fixture_id) prevByFixture.set(x.fixture_id, x);
    }

    // 4) osnovni sanity po tvojim pravilima (ne diramo vizuelno, samo filtar)
    const TRUSTED_MIN    = Number(process.env.TRUSTED_MIN ?? 2);
    const HIGH_ODDS_BTTS = Number(process.env.HIGH_ODDS_BTTS ?? 2.80);
    const HIGH_ODDS_OU   = Number(process.env.HIGH_ODDS_OU   ?? 3.00);
    const MAX_TIER2_ODDS = Number(process.env.MAX_TIER2_ODDS ?? 2.50);

    function baseSanity(p){
      const trusted = Number(p?.bookmakers_count_trusted||0);
      const odds    = Number(p?.market_odds||p?.odds||0);

      // OU FT mora biti 2.5 u selection tekstu
      if (isOU_FT(p) && !/2\.5/.test(String(p?.selection||""))) return false;

      // BTTS 1H — nema generičkog high-odds ograničenja, ali tražimo ≥3 trusted i EV≥0
      if (isBTTS1H(p)) {
        if (trusted < 3) return false;
        const ev = Number(p?.ev||0);
        if (!Number.isFinite(ev) || ev < 0) return false;
        return true;
      }

      // Ostali marketi:
      if (isBTTS_FT(p) && odds > HIGH_ODDS_BTTS && trusted < 3) return false;
      if (isOU_FT(p)    && odds > HIGH_ODDS_OU   && trusted < 3) return false;

      if (trusted < TRUSTED_MIN) return false;

      // Tier-2 clamp (disciplinuje srednje lige)
      if (tierHeuristic(p?.league)===2 && odds > MAX_TIER2_ODDS) return false;

      return true;
    }

    const sanePool = poolNotStarted.filter(baseSanity);
    if (!sanePool.length){
      await kvSet(finalKey, []);
      return res.status(200).json({ ok:true, updated:true, written:0, slot, note:"sanity removed all" });
    }

    // 5) score + stickiness (freeze samo PRE KO)
    const FREEZE_MIN       = Number(process.env.FREEZE_MIN ?? 30); // min pre KO bez zamene
    const STICKY_DELTA_PP  = Number(process.env.STICKY_DELTA_PP ?? 3); // koliko novi mora biti bolji

    function scoreOf(p){
      const conf = Number(p?.confidence_pct || 0);
      const odds = Number(p?.market_odds||p?.odds||0);
      const tier = tierHeuristic(p?.league);
      // mali penal na visoke kvote + bonus za Tier-1
      const penalty = odds>=3.0 ? 2 : odds>=2.5 ? 1 : 0;
      const bonus   = tier===1 ? (Number(process.env.TIER1_BONUS_PP ?? 1.5)) : (tier===2 ? Number(process.env.TIER2_BONUS_PP ?? 0.5) : 0);
      return conf + bonus - penalty;
    }

    const byFixture = new Map();
    for (const p of sanePool){
      const fid = p?.fixture_id; if (!fid) continue;
      const arr = byFixture.get(fid) || [];
      arr.push(p);
      byFixture.set(fid, arr);
    }

    const next = [];
    for (const [fid, arr] of byFixture){
      // rangiraj kandidate za isti meč
      arr.sort((a,b)=> scoreOf(b) - scoreOf(a) || Number(b?.ev||0) - Number(a?.ev||0) || (parseKO(a)-parseKO(b)));

      const prev = prevByFixture.get(fid);
      if (prev){
        const mins = minutesToKO(prev);
        const prevScore = scoreOf(prev);

        // FREEZE samo pre početka (mins>0)
        if (mins > 0 && mins <= FREEZE_MIN){ next.push(prev); continue; }

        const best = arr[0];
        const bestScore = scoreOf(best);
        const stillEVok = true; // EV pragove već proverava rebuild/learning; ovde zadržimo jednostavno

        if (stillEVok && bestScore < (prevScore + STICKY_DELTA_PP)){
          next.push(prev); continue;
        }
        next.push(best); continue;
      }

      // prvi izbor za meč
      next.push(arr[0]);
    }

    // 6) sortiraj po confidence, pa EV, pa kickoff
    function ts(p){ const d=parseKO(p); return d ? +d : Number.MAX_SAFE_INTEGER; }
    next.sort((a,b)=>{
      const ca=Number(a?.confidence_pct||0), cb=Number(b?.confidence_pct||0);
      if (cb!==ca) return cb-ca;
      const ea=Number(a?.ev||0), eb=Number(b?.ev||0);
      if (eb!==ea) return eb-ea;
      return ts(a)-ts(b);
    });

    // 7) upiši FINAL u :last (bez “hard cap” – koliko prođe, prođe)
    await kvSet(finalKey, next);

    return res.status(200).json({ ok:true, updated:true, written: next.length, slot, finalKey });
  } catch (e){
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
}
