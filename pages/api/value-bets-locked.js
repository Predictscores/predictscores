// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* =========================
 *  Inline helpers (KV)
 * ========================= */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGET(key, trace=[]) {
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const v = (j && ("result" in j ? j.result : j.value)) ?? null;
      if (v==null) continue;
      trace.push({ get:key, ok:true, flavor:b.flavor, hit:true });
      return v;
    } catch {}
  }
  trace.push({ get:key, ok:true, hit:false });
  return null;
}
function kvToItems(doc) {
  if (doc == null) return { items: [] };
  let v = doc;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { items: [] }; } }
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return { items: [] }; }
  }
  if (Array.isArray(v)) return { items: v };
  if (v && Array.isArray(v.items)) return v;
  return { items: [] };
}

/* =========================
 *  ENV / time helpers
 * ========================= */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function pickSlotAuto(now){ const h=hourInTZ(now, TZ); return h<10?"late":h<15?"am":"pm"; }

const VB_LIMIT = Number(process.env.VB_LIMIT || 25);
const VB_MAX_PER_LEAGUE = Number(process.env.VB_MAX_PER_LEAGUE || 2);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.50);
const MAX_ODDS = Number(process.env.MAX_ODDS || 5.50);
const UEFA_DAILY_CAP = Number(process.env.UEFA_DAILY_CAP || 6);

const CAP_LATE = Number(process.env.CAP_LATE || 6);
const CAP_AM_WD = Number(process.env.CAP_AM_WD || 15);
const CAP_PM_WD = Number(process.env.CAP_PM_WD || 15);
const CAP_AM_WE = Number(process.env.CAP_AM_WE || 20);
const CAP_PM_WE = Number(process.env.CAP_PM_WE || 20);

function isWeekend(ymd){
  const [y,m,d]=ymd.split("-").map(Number);
  const dt=new Date(Date.UTC(y,m-1,d,12,0,0));
  const wd=new Intl.DateTimeFormat("en-GB",{ timeZone:TZ, weekday:"short"}).format(dt).toLowerCase();
  return wd==="sat"||wd==="sun";
}
function isUEFA(league){ const n=String(league?.name||"").toLowerCase(); return /uefa|champions|europa|conference|ucl|uel|uecl/.test(n); }
function confFromOdds(odds){ if(!Number.isFinite(odds)||odds<=1) return 0; return Math.round(Math.max(0,Math.min(100,(1/odds)*100))); }
function oneXtwoCapForSlot(slot, we){ if(slot==="late") return CAP_LATE; if(!we) return slot==="am"?CAP_AM_WD:CAP_PM_WD; return slot==="am"?CAP_AM_WE:CAP_PM_WE; }

/* =========================
 *  Candidate builders
 * ========================= */
function fromMarkets(fix){
  const out=[]; const m=fix?.markets||{}; const fid=fix.fixture_id||fix.fixture?.id;

  if (m.btts?.yes && m.btts.yes>=MIN_ODDS && m.btts.yes<=MAX_ODDS) {
    const p=Number(m.btts.yes);
    out.push({fixture_id:fid,market:"BTTS",pick:"Yes",pick_code:"BTTS:Y",selection_label:"BTTS Yes",odds:{price:p},confidence_pct:confFromOdds(p)});
  }
  if (m.ou25?.over && m.ou25.over>=MIN_ODDS && m.ou25.over<=MAX_ODDS) {
    const p=Number(m.ou25.over);
    out.push({fixture_id:fid,market:"OU2.5",pick:"Over 2.5",pick_code:"O2.5",selection_label:"Over 2.5",odds:{price:p},confidence_pct:confFromOdds(p)});
  }
  if (m.fh_ou15?.over && m.fh_ou15.over>=MIN_ODDS && m.fh_ou15.over<=Math.max(MAX_ODDS,10)) {
    const p=Number(m.fh_ou15.over);
    out.push({fixture_id:fid,market:"FH_OU1.5",pick:"Over 1.5 FH",pick_code:"FH O1.5",selection_label:"FH Over 1.5",odds:{price:p},confidence_pct:confFromOdds(p)});
  }
  const htft=m.htft||{}; const ORDER=["hh","dd","aa","hd","dh","ha","ah","da","ad"];
  for (const code of ORDER){
    const p=Number(htft[code]);
    if (Number.isFinite(p) && p>=MIN_ODDS && p<=Math.max(MAX_ODDS,10)) {
      out.push({fixture_id:fid,market:"HTFT",pick:code.toUpperCase(),pick_code:`HTFT:${code.toUpperCase()}`,selection_label:`HT/FT ${code.toUpperCase()}`,odds:{price:p},confidence_pct:confFromOdds(p)});
      if (out.length>=6) break;
    }
  }
  for (const c of out) {
    c.league=fix.league; c.league_name=fix.league?.name; c.league_country=fix.league?.country;
    c.teams=fix.teams; c.home=fix.home; c.away=fix.away;
    c.kickoff=fix.kickoff; c.kickoff_utc=fix.kickoff_utc||fix.kickoff;
    c.model_prob=null;
  }
  return out;
}
function oneXtwoOffers(fix){
  const xs=[]; const x=fix?.markets?.['1x2']||{}; const fid=fix.fixture_id||fix.fixture?.id;
  const push=(code,label,price)=>{ if(Number.isFinite(price)&&price>=1.01) xs.push({
    fixture_id:fid, market:"1x2", pick:code, selection_label:label, odds:{price:Number(price)},
    confidence_pct:confFromOdds(Number(price)), league:fix.league, league_name:fix.league?.name,
    league_country:fix.league?.country, teams:fix.teams, home:fix.home, away:fix.away,
    kickoff:fix.kickoff, kickoff_utc:fix.kickoff_utc||fix.kickoff
  })};
  if (x.home) push("1","Home",x.home);
  if (x.draw) push("X","Draw",x.draw);
  if (x.away) push("2","Away",x.away);
  return xs;
}
function capPerLeague(items, maxPerLeague){
  const per=new Map(), out=[];
  for (const it of items){
    const key=String(it?.league?.id||it?.league_name||"?");
    const cur=per.get(key)||0; if (cur>=maxPerLeague) continue;
    per.set(key,cur+1); out.push(it);
  }
  return out;
}
function topKPerMarket(items, kMin=3, kMax=5){
  const buckets = { BTTS:[], "OU2.5":[], "FH_OU1.5":[], HTFT:[] };
  for (const it of items) if (buckets[it.market]) buckets[it.market].push(it);
  for (const key of Object.keys(buckets)) buckets[key].sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
  const clamp = arr => arr.slice(0, Math.max(kMin, Math.min(kMax, arr.length)));
  return {
    btts:   clamp(buckets.BTTS),
    ou25:   clamp(buckets["OU2.5"]),
    fh_ou15:clamp(buckets["FH_OU1.5"]),
    htft:   clamp(buckets.HTFT),
  };
}
function applyUefaCap(items, cap){
  const out=[]; let cnt=0;
  for (const it of items){
    if (isUEFA(it.league)) { if (cnt>=cap) continue; cnt++; }
    out.push(it);
  }
  return out;
}

/* =========================
 *  Handler
 * ========================= */
export default async function handler(req,res){
  const trace=[];
  try{
    const now=new Date(); const ymd=ymdInTZ(now, TZ);
    let slot=String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot=pickSlotAuto(now);
    const weekend=isWeekend(ymd);

    const unionKey=`vb:day:${ymd}:${slot}`;
    const fullKey =`vbl_full:${ymd}:${slot}`;
    const union=kvToItems(await kvGET(unionKey, trace));
    const full =kvToItems(await kvGET(fullKey,  trace));
    const base = full.items.length ? full.items : union.items;

    if (!base.length) {
      return res.status(200).json({
        ok:true, ymd, slot, source:null,
        items:[], tickets:{ btts:[], ou25:[], fh_ou15:[], htft:[] }, one_x_two: [],
        debug:{ trace }
      });
    }

    // Svi kandidati (BTTS/OU/FH/HTFT), real-odds confidence
    const candidates=[]; for (const f of base) candidates.push(...fromMarkets(f));

    // Rang po confidence, UEFA cap, per-league cap
    const ranked = candidates.slice().sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
    const afterUefa = applyUefaCap(ranked, UEFA_DAILY_CAP);
    const leagueCapped = capPerLeague(afterUefa, VB_MAX_PER_LEAGUE);

    // Football tab (kombinovani topN)
    const topN = leagueCapped.slice(0, VB_LIMIT);

    // Tiketi: topK po tržištu (garantuje FH tiket ako postoji ponuda)
    const tickets = topKPerMarket(leagueCapped, 3, 5);

    // 1x2 ponude (po slot cap-u + per-liga)
    const oneXtwoAll=[]; for (const f of base) oneXtwoAll.push(...oneXtwoOffers(f));
    oneXtwoAll.sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
    const oneXtwoCap = oneXtwoCapForSlot(slot, weekend);
    const one_x_two = capPerLeague(oneXtwoAll, VB_MAX_PER_LEAGUE).slice(0, oneXtwoCap);

    return res.status(200).json({
      ok:true, ymd, slot, source: full.items.length?"vbl_full":"vb:day",
      items: topN, tickets, one_x_two, debug:{ trace }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
