// pages/api/cron/rebuild.js
// Reads today's union + odds enrichment, applies ENV gates (MIN_ODDS, EV_*, spreads, trusted),
// caps per league, and writes:
//   - vbl_full:YYYY-MM-DD:<slot>  (15–20 kom po slotu, prema CAP_* ENV)
//   - tickets:YYYY-MM-DD[:<slot>] (btts/ou25/htft)  – selection_label dolazi iz trusted konsenzusa

export const config = { api: { bodyParser:false } };

/* ---------------- ENV & helpers ---------------- */
const TZ = process.env.TZ || "Europe/Belgrade";

// caps
const CAP_LATE   = Number(process.env.CAP_LATE || 6);
const CAP_AM_WD  = Number(process.env.CAP_AM_WD || 15);
const CAP_PM_WD  = Number(process.env.CAP_PM_WD || 15);
const CAP_AM_WE  = Number(process.env.CAP_AM_WE || 20);
const CAP_PM_WE  = Number(process.env.CAP_PM_WE || 20);

// model/gates
const MIN_ODDS             = Number(process.env.MIN_ODDS || 1.5);
const EV_FLOOR             = Number(process.env.EV_FLOOR || 0.02);
const EV_LB_FLOOR          = Number(process.env.EV_LB_FLOOR || 0.01);
const EV_Z                 = Number(process.env.EV_Z || 0.67);
const ALL_SPREAD_MAX       = Number(process.env.ALL_SPREAD_MAX || 0.2);
const TRUSTED_SPREAD_MAX   = Number(process.env.TRUSTED_SPREAD_MAX || 0.2);
const ONE_TRUSTED_TOL      = Number(process.env.ONE_TRUSTED_TOL || 0.05);
const VB_MAX_PER_LEAGUE    = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2) || 2);
const EXCLUDE_LOW_TIERS    = String(process.env.EXCLUDE_LOW_TIERS || "1") === "1";
const UEFA_DAILY_CAP       = Math.max(1, Number(process.env.UEFA_DAILY_CAP || 6) || 6);

const TRUSTED_BOOKIES = new Set(
  String(process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const ODDS_TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";

function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(fmt.format(d),10);
}
function deriveSlot(h){ if (h<10) return "late"; if (h<15) return "am"; return "pm"; }
function isWeekend(tz=TZ){
  const wd = new Intl.DateTimeFormat("en-GB",{ weekday:"short", timeZone:tz }).format(new Date());
  return (wd==="Sat" || wd==="Sun");
}
function desiredCap(slot, tz=TZ){
  if (slot==="late") return CAP_LATE;
  return isWeekend(tz) ? (slot==="am" ? CAP_AM_WE : CAP_PM_WE) : (slot==="am" ? CAP_AM_WD : CAP_PM_WD);
}
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };

/* ---------------- KV ---------------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try{
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers:{Authorization:`Bearer ${b.tok}`}, cache:"no-store" });
      const ok = r.ok; const j = ok ? await r.json().catch(()=>null) : null;
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      trace && trace.push({ key, flavor:b.flavor, ok, status: ok ? (val?"hit":"miss") : `http-${r.status}` });
      if (val) return { raw: val, flavor: b.flavor };
    }catch(e){ trace && trace.push({ key, flavor:b.flavor, status:`err:${String(e?.message||e)}` }); }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value, trace){
  const payload = JSON.stringify(value);
  for (const b of kvBackends()) {
    try{
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method:"POST",
        headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},
        body: JSON.stringify({ value: payload })
      });
      trace && trace.push({ key, flavor:b.flavor+":rw", ok:r.ok });
    }catch(e){ trace && trace.push({ key, flavor:b.flavor+":rw", ok:false, err:String(e?.message||e) }); }
  }
}

/* ---------------- EV & filters ---------------- */
function implied(p){ return p>0 ? 1/p : 0; }           // implied prob from odds
function ev(modelProb, price){
  const q = implied(price); if (!q) return -1;
  return modelProb - q;                                // simple EV on prob space
}
function zScore(modelProb, price){
  // crude z ~ (p - q) / sqrt(q*(1-q))  (for screening only)
  const q = implied(price);
  const varq = q*(1-q) || 1e-9;
  return (modelProb - q) / Math.sqrt(varq);
}

function leagueTier(league){
  const name = (league?.name || "").toLowerCase();
  const country = (league?.country || "").toLowerCase();
  if (/(champions league|europa league|conference league)/i.test(league?.name || "")) return 1;
  if (/(premier league|la liga|serie a|bundesliga|ligue 1)/i.test(league?.name || "")) return 1;
  if (/(j1 league|eredivisie|primeira liga|mls|championship)/i.test(league?.name || "")) return 2;
  return 3;
}

function passOddsConsensus(cons, { allSpreadMax=ALL_SPREAD_MAX, trustedSpreadMax=TRUSTED_SPREAD_MAX } = {}){
  if (!cons) return false;
  // accept if we either don't have spread OR under limits; prefer trusted if available
  const okAll = (cons.price_spread==null) || (cons.price_spread <= allSpreadMax);
  if (!okAll) return false;
  if (cons.trusted_count>0){
    const okTr = (cons.price_spread==null) || (cons.price_spread <= trustedSpreadMax);
    return okTr;
  }
  // no trusted: allow only if not strictly trusted-only and at least 2 books
  return !ODDS_TRUSTED_ONLY && (cons.books_count >= 2);
}

/* ---------- choose selection from consensus by EV vs model ---------- */
function pickFromConsensus(market, consensus, model){
  // model carries probabilities for each selection (if available). We fall back to the item's pick/market when missing.
  if (!consensus) return null;

  function bestOf(entries){
    let best=null;
    for (const [label, cons] of entries){
      if (!cons || cons.price < MIN_ODDS) continue;
      if (!passOddsConsensus(cons)) continue;
      const p = (model?.[label] ?? model?.p ?? 0); // try label-specific prob, else single p
      const evv = ev(p, cons.price);
      const z = zScore(p, cons.price);
      // gates
      if (evv < EV_FLOOR) continue;
      if (z < EV_Z) continue;
      if (cons.trusted_count<=1 && cons.price_spread!=null && cons.price_spread > ONE_TRUSTED_TOL) continue;

      const cand = { selection_label: label, price: cons.price, books_count: cons.books_count, trusted_count: cons.trusted_count, price_spread: cons.price_spread, ev: evv, z };
      if (!best || cand.ev > best.ev) best = cand;
    }
    return best;
  }

  if (market==="1X2"){
    return bestOf([
      ["Home", consensus.home],
      ["Draw", consensus.draw],
      ["Away", consensus.away],
    ]);
  }
  if (market==="BTTS"){
    return bestOf([
      ["Yes", consensus.yes],
      ["No",  consensus.no ],
    ]);
  }
  if (market==="OU25"){
    return bestOf([
      ["Over 2.5", consensus.over],
      ["Under 2.5", consensus.under],
    ]);
  }
  if (market==="HTFT"){
    // HT/FT map
    return bestOf(Object.entries(consensus)); // labels like “Home/Home”, …
  }
  return null;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res){
  const trace = [];
  try{
    res.setHeader("Cache-Control","no-store");
    const q = req.query||{};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const slot = String(q.slot||"").trim() || deriveSlot(hourInTZ(now, TZ));

    // read union base and odds enrichment
    const { raw:rawBase } = await kvGETraw(`vb:day:${ymd}:${slot}:union`, trace);
    const { raw:rawOdds } = await kvGETraw(`vb:day:${ymd}:${slot}:odds`, trace);

    const baseArr = J(rawBase);
    const oddsObj = J(rawOdds);

    const list = Array.isArray(baseArr) ? baseArr : [];
    const oddsByFx = {};
    for (const o of (oddsObj?.odds || [])) oddsByFx[o.fixture] = o.consensus || {};

    // per-league counters
    const leagueCount = new Map();
    let uefaCount = 0;

    const kept = [];
    const tickets = { slot_btts:[], slot_ou25:[], slot_htft:[] };

    for (const it of list){
      const fx = it?.fixture_id || it?.fixture?.id || it?.id;
      const lg = it?.league || {};
      const tier = leagueTier(lg);

      if (EXCLUDE_LOW_TIERS && tier===3) continue;

      const leagueKey = lg?.id || lg?.name || "unknown";
      const already = leagueCount.get(leagueKey) || 0;
      if (already >= VB_MAX_PER_LEAGUE) continue;

      const isUefa = /Champions League|Europa League|Conference League/i.test(lg?.name || "");
      if (isUefa && uefaCount >= UEFA_DAILY_CAP) continue;

      // find consensus for this fixture & market
      const cons = oddsByFx[fx] || {};
      const market = String(it?.market || it?.market_label || "1X2").toUpperCase();
      let pick = null;

      // model probability area
      const mpct = (Number(it?.model_prob) || Number(it?.confidence_pct)/100 || 0);
      const model = { p: mpct>1? mpct/100 : mpct };

      if (market==="1X2" || market==="MATCH ODDS" || market==="H2H"){
        pick = pickFromConsensus("1X2", cons.H2H, model);
      } else if (market.includes("BTTS")){
        pick = pickFromConsensus("BTTS", cons.BTTS, model);
      } else if (market.includes("O/U") || market.includes("OU")){
        pick = pickFromConsensus("OU25", cons.OU25, model);
      } else if (market.includes("HT") && market.includes("FT")){
        pick = pickFromConsensus("HTFT", cons.HTFT, model);
      }

      // if we failed to pick from consensus, skip
      if (!pick || pick.price < MIN_ODDS) continue;

      const item = {
        ...it,
        odds: {
          price: pick.price,
          books_count: pick.books_count,
          trusted_count: pick.trusted_count,
          price_spread: pick.price_spread
        },
        selection_label: pick.selection_label,
      };

      kept.push(item);
      leagueCount.set(leagueKey, already+1);
      if (isUefa) uefaCount++;

      // tickets (only if market != 1X2)
      if (market.includes("BTTS")){
        tickets.slot_btts.push({ ...item, market:"BTTS" });
      }else if (market.includes("O/U") || market.includes("OU")){
        tickets.slot_ou25.push({ ...item, market:"O/U 2.5" });
      }else if (market.includes("HT") && market.includes("FT")){
        tickets.slot_htft.push({ ...item, market:"HT-FT" });
      }
    }

    // sort by confidence/KO time, then cap to desired per-slot
    kept.sort((a,b)=>{
      const cp = (Number(b.confidence_pct)||Number(b.model_prob)||0) - (Number(a.confidence_pct)||Number(a.model_prob)||0);
      if (cp) return cp;
      const ta = Date.parse(a.kickoff_utc || a.kickoff || a?.fixture?.date || 0);
      const tb = Date.parse(b.kickoff_utc || b.kickoff || b?.fixture?.date || 0);
      return ta - tb;
    });

    const slotCap = desiredCap(slot, TZ);
    const returned = kept.slice(0, slotCap);

    // tickets — uzmi top 4 po EV za svaku grupu
    function topN(arr){
      return [...arr].sort((a,b)=>{
        const ea = ev(Number(a.model_prob)||Number(a.confidence_pct)/100||0, Number(a?.odds?.price)||0);
        const eb = ev(Number(b.model_prob)||Number(b.confidence_pct)/100||0, Number(b?.odds?.price)||0);
        return eb - ea;
      }).slice(0,4);
    }
    const btts = topN(tickets.slot_btts);
    const ou25 = topN(tickets.slot_ou25);
    const htft = topN(tickets.slot_htft);

    // save
    const saveVbl = `vbl_full:${ymd}:${slot}`;
    const saveTicketsSlot = `tickets:${ymd}:${slot}`;
    const saveTicketsDay  = `tickets:${ymd}`;

    await kvSET(saveVbl, returned, trace);
    await kvSET(saveTicketsSlot, { btts, ou25, htft }, trace);
    // takođe snimimo i dnevni agregat (za fallback)
    await kvSET(saveTicketsDay,  { btts, ou25, htft }, trace);

    return res.status(200).json({
      ok:true,
      ymd, slot,
      counts:{ base:list.length, kept: returned.length },
      saved:[ saveVbl, saveTicketsSlot, saveTicketsDay ],
      tickets:{ slot_btts:btts.length, slot_ou25:ou25.length, slot_htft:htft.length },
      diag:{ reads:[`vb:day:${ymd}:${slot}:union`,`vb:day:${ymd}:${slot}:odds`] , env:{ MIN_ODDS, EV_FLOOR, EV_LB_FLOOR, EV_Z, ALL_SPREAD_MAX, TRUSTED_SPREAD_MAX, ONE_TRUSTED_TOL, VB_MAX_PER_LEAGUE } }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e), debug:{ trace } });
  }
}
