// pages/api/insights-build.js
// Tiketi se pune iz celodnevnog pool-a (vb:day:<YMD>:union) ili iz slot feeda ako pool ne postoji.
// Radi i kada je union plain-array ili {items}. Zadrži 4 po tiketu ako ih ima.

export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();

const MIN_ODDS = 1.5;
const PER_LEAGUE_CAP = 2;
const TARGET_PER_TICKET = 4;

/* ---------- KV ---------- */
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

/* ---------- TZ-safe ---------- */
function tzNowParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => Number(parts.find(p => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), H: get("hour") };
}
function ymdFromParts(p) { return `${p.y}-${String(p.m).padStart(2,"0")}-${String(p.d).padStart(2,"0")}`; }
function slotFromQuery(q){
  const s=(q.slot||"").toString().trim().toLowerCase();
  if(s==="am"||s==="pm"||s==="late") return s;
  const {H}=tzNowParts(); if(H<10) return "late"; if(H<15) return "am"; return "pm";
}

/* ---------- shape ---------- */
function getItems(feed){
  if(!feed) return null;
  if(Array.isArray(feed)) return feed;
  if(Array.isArray(feed.items)) return feed.items;
  return null;
}

/* ---------- utils ---------- */
function safeConf(it){ const c=Number(it?.confidence_pct); return Number.isFinite(c)?c:50; }
function leagueId(it){ return it?.league?.id ?? it?.league_id ?? "unknown"; }
function priceFrom(o){ const p=Number(o?.price); return Number.isFinite(p)?p:null; }
function passMin(p){ return p==null ? true : p>=MIN_ODDS; }
function pickTop(items, want){
  const byLg=new Map(), out=[];
  for(const it of items){
    const lg=leagueId(it); const have=byLg.get(lg)||0;
    if(have>=PER_LEAGUE_CAP) continue;
    out.push(it); byLg.set(lg,have+1);
    if(out.length>=want) break;
  }
  return out;
}

/* ---- kandidati ---- */
function bttsCandidates(list){
  const a=[];
  for(const it of list){
    const m=it?.markets?.btts; const y=priceFrom(m?.Y);
    if(!passMin(y)) continue;
    a.push({
      fixture_id:it.fixture_id, league:it.league, teams:it.teams,
      pick:"Yes", pick_code:"Y", market:"BTTS", market_label:"BTTS",
      odds:{ price:y, books_count:Number(m?.Y?.books_count||0) },
      confidence_pct:safeConf(it), kickoff_utc:it.kickoff_utc
    });
  }
  a.sort((x,y)=> (y.confidence_pct-x.confidence_pct)
                 || (y.odds.books_count-x.odds.books_count)
                 || (y.odds.price-x.odds.price));
  return a;
}
function ou25Candidates(list){
  const a=[];
  for(const it of list){
    const m=it?.markets?.ou25; const o=priceFrom(m?.over);
    if(!passMin(o)) continue;
    a.push({
      fixture_id:it.fixture_id, league:it.league, teams:it.teams,
      pick:"Over 2.5", pick_code:"O", market:"OU2.5", market_label:"O/U 2.5",
      odds:{ price:o, books_count:Number(m?.over?.books_count||0) },
      confidence_pct:safeConf(it), kickoff_utc:it.kickoff_utc
    });
  }
  a.sort((x,y)=> (y.confidence_pct-x.confidence_pct)
                 || (y.odds.books_count-x.odds.books_count)
                 || (y.odds.price-x.odds.price));
  return a;
}
function htftCandidates(list){
  const a=[];
  for(const it of list){
    const px=priceFrom(it?.odds); if(!passMin(px)) continue;
    if(!it?.pick_code) continue;
    a.push({
      fixture_id:it.fixture_id, league:it.league, teams:it.teams,
      pick:it.pick||it.selection_label||it.pick_code, pick_code:it.pick_code,
      market:"HT-FT", market_label:"HT-FT",
      odds:{ price:px, books_count:Number(it?.odds?.books_count||0) },
      confidence_pct:safeConf(it), kickoff_utc:it.kickoff_utc
    });
  }
  a.sort((x,y)=> (y.confidence_pct-x.confidence_pct)
                 || (y.odds.books_count-x.odds.books_count)
                 || (y.odds.price-x.odds.price));
  return a;
}

/* ---------- handler ---------- */
export default async function handler(req,res){
  try{
    const p=tzNowParts(); const day=ymdFromParts(p);
    const slot=slotFromQuery(req.query);

    const poolKey = `vb:day:${day}:union`;
    const fullKey = `vbl_full:${day}:${slot}`;

    const poolRaw = await kvGet(poolKey);
    const fullRaw = await kvGet(fullKey);

    const items = getItems(poolRaw) || getItems(fullRaw);
    if(!Array.isArray(items) || !items.length){
      return res.status(200).json({ ok:true, ymd:day, slot, source: items ? poolKey : fullKey, counts:{btts:0,ou25:0,htft:0} });
    }

    const cBTTS = bttsCandidates(items);
    const cOU25 = ou25Candidates(items);
    const cHTFT = htftCandidates(items);

    const picksBTTS = pickTop(cBTTS, TARGET_PER_TICKET);
    const picksOU25 = pickTop(cOU25, TARGET_PER_TICKET);
    const picksHTFT = pickTop(cHTFT, TARGET_PER_TICKET);

    const tickets = { btts: picksBTTS, ou25: picksOU25, htft: picksHTFT };
    const tkKey = `tickets:${day}:${slot}`;
    await kvSet(tkKey, tickets);

    return res.status(200).json({
      ok:true, ymd:day, slot, source: Array.isArray(poolRaw)?poolKey: (poolRaw&&poolKey)||fullKey,
      counts:{ btts:picksBTTS.length, ou25:picksOU25.length, htft:picksHTFT.length }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
