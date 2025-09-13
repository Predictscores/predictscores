// pages/api/cron/refresh-odds.js
// Enrich vbl_full:<YMD>:<slot> median kvotama (trusted) + BTTS/OU2.5 iz The Odds API.
// • 1 OA poziv po slotu, ukupno max 15/dan (guard u KV: oa:budget:<ymd>)

export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OA_KEY = process.env.ODDS_API_KEY;
const TZ = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();

/* ---------- KV helpers ---------- */
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store"
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  try { return j && j.result ? JSON.parse(j.result) : null; } catch { return null; }
}
async function kvSet(key, val) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(val) })
  });
  return r.ok;
}

/* ---------- TZ-safe helpers (bez new Date nad locale stringom) ---------- */
function tzNowParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => Number(parts.find(p => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), H: get("hour"), M: get("minute"), S: get("second") };
}
function ymdFromParts(p) { return `${p.y}-${String(p.m).padStart(2,"0")}-${String(p.d).padStart(2,"0")}`; }
function slotFromQuery(q) {
  const s = (q.slot || "").toString().trim().toLowerCase();
  if (s === "am" || s === "pm" || s === "late") return s;
  const { H } = tzNowParts();
  if (H < 10) return "late";
  if (H < 15) return "am";
  return "pm";
}

/* ---------- Odds helpers ---------- */
const TRUSTED = new Set([
  "pinnacle","bet365","unibet","bwin","williamhill",
  "marathonbet","skybet","betfair","888sport","sbobet"
]);
function normalizeName(s){
  return (s||"").toLowerCase().replace(/club|fc|cf|sc|ac|afc|bc|[.\-']/g," ").replace(/\s+/g," ").trim();
}
function median(vals){ const a=vals.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length) return null; const i=Math.floor(a.length/2); return a.length%2?a[i]:(a[i-1]+a[i])/2; }
function pickMedian(offers, proj){
  const all=[], tr=[];
  for(const b of offers||[]){
    const v = proj(b);
    if(Number.isFinite(v)){ all.push(v); if(TRUSTED.has((b.title||b.name||"").toLowerCase())) tr.push(v); }
  }
  const base = tr.length ? tr : all;
  return { price: median(base), books_count: base.length };
}
function indexOA(list){
  const m=new Map();
  for(const ev of list||[]){
    const k = `${normalizeName(ev.home_team)}|${normalizeName(ev.away_team)}`;
    if(k.includes("undefined")) continue;
    m.set(k, ev);
  }
  return m;
}
function extractMarkets(ev){
  const out={ h2h:null, totals25:{over:null,under:null}, btts:{Y:null,N:null} };
  if(!ev||!Array.isArray(ev.bookmakers)) return out;

  const h2h=[], totals=[], btts=[];
  for(const bk of ev.bookmakers){
    for(const mk of bk.markets||[]){
      if(mk.key==="h2h" && Array.isArray(mk.outcomes)){
        const get=n=>mk.outcomes.find(o=>(o.name||o.title)===n)?.price;
        h2h.push({ title:bk.title||bk.key||"", h:get("Home"), d:get("Draw"), a:get("Away") });
      }
      if(mk.key==="totals" && Array.isArray(mk.outcomes)){
        for(const o of mk.outcomes){
          const pt=Number(o.point);
          if(pt===2.5) totals.push({ title:bk.title||bk.key||"", o:o.name==="Over"?o.price:undefined, u:o.name==="Under"?o.price:undefined });
        }
      }
      if((mk.key==="btts"||mk.key==="both_teams_to_score") && Array.isArray(mk.outcomes)){
        const get=n=>mk.outcomes.find(o=>(o.name||o.title)===n)?.price;
        btts.push({ title:bk.title||bk.key||"", y:get("Yes"), n:get("No") });
      }
    }
  }
  if(h2h.length){
    out.h2h = { home: pickMedian(h2h,b=>Number(b.h)), draw: pickMedian(h2h,b=>Number(b.d)), away: pickMedian(h2h,b=>Number(b.a)) };
  }
  if(totals.length){
    out.totals25 = { over: pickMedian(totals,b=>Number(b.o)), under: pickMedian(totals,b=>Number(b.u)) };
  }
  if(btts.length){
    out.btts = { Y: pickMedian(btts,b=>Number(b.y)), N: pickMedian(btts,b=>Number(b.n)) };
  }
  return out;
}
async function callOAOnce(ymdStr){
  if(!OA_KEY) return { called:false, used_before:0, used_after:0, events:0, data:[] };
  const keyBudget=`oa:budget:${ymdStr}`;
  const b=(await kvGet(keyBudget))||{used:0};
  const used_before=Number(b.used||0);
  if(used_before>=15) return { called:false, used_before, used_after:used_before, events:0, data:[] };

  const url=`https://api.the-odds-api.com/v4/sports/upcoming/odds?regions=eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso&apiKey=${encodeURIComponent(OA_KEY)}`;
  let data=[];
  try{ const r=await fetch(url,{cache:"no-store"}); if(r.ok) data=await r.json(); }catch{}
  await kvSet(keyBudget,{used:used_before+1});
  return { called:true, used_before, used_after:used_before+1, events:Array.isArray(data)?data.length:0, data:Array.isArray(data)?data:[] };
}

/* ---------- Handler ---------- */
export default async function handler(req,res){
  const p = tzNowParts();
  const day = ymdFromParts(p);
  const slot = slotFromQuery(req.query);

  const keyFull = `vbl_full:${day}:${slot}`;
  const src = await kvGet(keyFull);
  if(!src || !Array.isArray(src.items)){
    return res.status(200).json({ ok:true, ymd:day, slot, msg:"no vbl_full", saves:false, oa:{called:false, used_before:0, used_after:0, events:0} });
  }

  const oa = await callOAOnce(day);
  const idx = indexOA(oa.data);

  let touched=0;
  for(const it of src.items){
    try{
      const h=normalizeName(it?.teams?.home?.name||it?.home?.name);
      const a=normalizeName(it?.teams?.away?.name||it?.away?.name);
      if(!h||!a) continue;
      const ev = idx.get(`${h}|${a}`);
      if(!ev) continue;

      const m = extractMarkets(ev);
      it.markets = it.markets || {};
      if(m.h2h)   it.markets.h2h  = m.h2h;
      if(m.totals25) it.markets.ou25 = { over:m.totals25.over, under:m.totals25.under };
      if(m.btts)  it.markets.btts = m.btts;
      touched++;
    }catch{}
  }

  await kvSet(keyFull, src);

  return res.status(200).json({
    ok:true, ymd:day, slot,
    inspected: src.items.length, touched,
    source: keyFull, saves:[{flavor:"vercel-kv",ok:true}],
    oa
  });
}
