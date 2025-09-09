// pages/api/cron/rebuild.js

export const config = { api: { bodyParser: false } };

const TZ = (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) || "Europe/Belgrade";
const TARGET_N = 15;
const MIN_ODDS  = 1.5;
const LANES = 4;
const TICKETS_PER_MARKET = Number(process.env.TICKETS_PER_MARKET || 4);

/* ---------- KV helpers ---------- */
function kvCfgs() {
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw  = process.env.KV_REST_API_TOKEN || "";
  const ro  = process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const ups = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const upT = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const cfgs = [];
  if (url && rw) cfgs.push({ flavor:"vercel-kv:rw", url, token:rw });
  if (url && ro) cfgs.push({ flavor:"vercel-kv:ro", url, token:ro });
  if (ups && upT) cfgs.push({ flavor:"upstash:rw", url:ups, token:upT });
  return cfgs;
}
async function kvGET(key, diag){
  for (const c of kvCfgs()){
    try{
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${c.token}` }, cache:"no-store" });
      const ok=r.ok; const j= ok ? await r.json().catch(()=>null) : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, ok, status: ok?(j?.result?"hit":"miss"):`http-${r.status}` });
      if (ok && typeof j?.result === "string" && j.result) return { raw:j.result, flavor:c.flavor };
    }catch(e){
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, valueString, diag){
  const saved=[];
  for (const c of kvCfgs().filter(x=>x.flavor.endsWith(":rw"))){
    try{
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`,{
        method:"POST",
        headers:{ Authorization:`Bearer ${c.token}`, "Content-Type":"application/json" },
        cache:"no-store",
        body:valueString,
      });
      saved.push({ flavor:c.flavor, ok:r.ok });
    }catch(e){ saved.push({ flavor:c.flavor, ok:false, err:String(e?.message||e) }); }
  }
  diag && (diag.writes = diag.writes || []).push({ key, saved });
  return saved;
}
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x==="object"){
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value==="string"){ const v=J(x.value); if (Array.isArray(v)) return v; if (v&&typeof v==="object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
  }
  if (typeof x==="string"){ const v=J(x); if (Array.isArray(v)) return v; if (v&&typeof v==="object") return arrFromAny(v); }
  return null;
}

/* ---------- helpers ---------- */
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
function implied(o){ const x=Number(o||0); return (isFinite(x)&&x>0) ? 1/x : 0; }
function scoreForSort(x){
  const mp = Math.max(0, Math.min(1, Number(x?.model_prob)||0));
  const imp = implied(x?.odds?.price || x?.market_odds || 0);
  const edge = Math.max(0, mp - imp);
  return mp*100 + edge*100;
}
const YOUTH = [/\bU(-|\s)?(17|18|19|20|21|22|23)\b/i, /\bPrimavera\b/i, /\bYouth\b/i];
function isYouthOrBanned(item){
  const ln = (item?.league_name || item?.league?.name || "").toString();
  const tnH = (item?.home || item?.teams?.home?.name || "").toString();
  const tnA = (item?.away || item?.teams?.away?.name || "").toString();
  const s = `${ln} ${tnH} ${tnA}`;
  return YOUTH.some(rx=>rx.test(s));
}

/* ---------- API-Football ---------- */
const AF_BASE = "https://v3.football.api-sports.io";
const afFixturesHeaders = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim() });
const afOddsHeaders     = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim() });

async function afFetch(path, params={}, headers={}){
  const usp = new URLSearchParams(params||{});
  const url = `${AF_BASE}${path}?${usp.toString()}`;
  const r = await fetch(url, { headers, cache:"no-store" });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  return await r.json();
}
function mapFixtureToItem(fx){
  const f = fx?.fixture || {};
  const l = fx?.league || {};
  const t = fx?.teams || {};
  const home = t?.home?.name || "";
  const away = t?.away?.name || "";
  const kickoff_utc = f?.date || null;
  return {
    fixture_id: Number(f?.id)||0,
    league: { id:Number(l?.id)||0, name:l?.name||"", country:l?.country||"" },
    league_name: l?.name || "",
    league_country: l?.country || "",
    teams: t,
    home, away,
    kickoff_utc,
  };
}
async function fetchAllFixturesForDate(ymd){
  const j = await afFetch("/fixtures", { date:ymd }, afFixturesHeaders());
  return j?.response || [];
}
function slotForKickoffISO(iso){
  const h = new Date(iso).toLocaleString("en-GB",{ hour:"2-digit", hour12:false, timeZone:TZ });
  const v = parseInt(h,10);
  if (v<10) return "late"; if (v<15) return "am"; return "pm";
}

/* ---------- market helpers (iz AF /odds strukture) ---------- */
function norm(s){ return String(s||"").toLowerCase(); }
function best1x2(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  for (const b of bookmakers||[]){
    const nm=norm(b.name);
    if (!nm || /special/i.test(nm)) continue;
    for (const bet of b.bets||[]){
      const nm=String(bet.name||"").toLowerCase();
      if (!(nm.includes("1x2")||nm.includes("match winner")||nm.includes("winner"))) continue;
      books++;
      const vals=bet.values||[];
      const vH=vals.find(v=>/^home$/i.test(v.value||""));
      const vD=vals.find(v=>/^draw$/i.test(v.value||""));
      const vA=vals.find(v=>/^away$/i.test(v.value||""));
      if (!vH||!vD||!vA) continue;
      const oH=parseFloat(vH.odd), oD=parseFloat(vD.odd), oA=parseFloat(vA.odd);
      if (!isFinite(oH)||!isFinite(oD)||!isFinite(oA)) continue;
      const pH=1/oH, pD=1/oD, pA=1/oA, S=pH+pD+pA;
      const cands=[
        { code:"1", label:"Home", odd:oH, prob:pH/S },
        { code:"X", label:"Draw", odd:oD, prob:pD/S },
        { code:"2", label:"Away", odd:oA, prob:pA/S },
      ].filter(c=>c.odd>=minOdds);
      if (!cands.length) continue;
      cands.sort((a,b)=>b.prob-a.prob);
      const pick=cands[0];
      const chosen={ pick_code:pick.code, pick:pick.label, model_prob:pick.prob, odds:{ price:pick.odd, books_count:1 } };
      if (!best || chosen.model_prob>best.model_prob || (Math.abs(pick.prob-best.model_prob)<1e-9 && chosen.odds.price<best.odds.price))
        best=chosen;
    }
  }
  if (best) best.odds.books_count=Math.max(1,books);
  return best;
}
function bestBTTS(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  for (const b of bookmakers||[]){
    const nm=norm(b.name);
    if (!nm || /special/i.test(nm)) continue;
    for (const bet of b.bets||[]){
      const nm=String(bet.name||"").toLowerCase();
      if (!(nm.includes("btts")||nm.includes("both teams to score")||nm.includes("gg"))) continue;
      books++;
      const vals=bet.values||[];
      const vY=vals.find(v=>/^yes$/i.test(v.value||""));
      const vN=vals.find(v=>/^no$/i.test(v.value||""));
      if (!vY && !vN) continue;
      const cand=[vY,vN].filter(Boolean).map(v=>({ pick:v.value, odd:parseFloat(v.odd) }))
        .filter(x=>isFinite(x.odd) && x.odd>=minOdds)
        .map(x=>({ selection:x.pick, market_odds:x.odd, model_prob:1/x.odd }));
      if (!cand.length) continue;
      cand.sort((a,b)=>b.model_prob-a.model_prob);
      const top=cand[0];
      if (!best || top.model_prob>best.model_prob || (Math.abs(top.model_prob-best.model_prob)<1e-9 && top.market_odds<best.market_odds))
        best={ market:"BTTS", selection:top.selection, market_odds:top.market_odds, model_prob:top.model_prob, bookmakers_count:1 };
    }
  }
  if (best) best.bookmakers_count=Math.max(1,books);
  return best;
}
function bestOU25(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  for (const b of bookmakers||[]){
    const nm=norm(b.name);
    if (!nm || /special/i.test(nm)) continue;
    for (const bet of b.bets||[]){
      const nm=String(bet.name||"").toLowerCase();
      if (!(nm.includes("over/under")||nm.includes("totals"))) continue;
      books++;
      const vals=(bet.values||[]).filter(v=>String(v.value||"").includes("2.5"));
      const cand=vals.map(v=>({ selection:v.value, odd:parseFloat(v.odd) }))
        .filter(x=>isFinite(x.odd) && x.odd>=minOdds)
        .map(x=>({ selection:x.selection, market_odds:x.odd, model_prob:1/x.odd }));
      if (!cand.length) continue;
      cand.sort((a,b)=>b.model_prob-a.model_prob);
      const top=cand[0];
      if (!best || top.model_prob>best.model_prob || (Math.abs(top.model_prob-best.model_prob)<1e-9 && top.market_odds<best.market_odds))
        best={ market:"OU 2.5", selection:top.selection, market_odds:top.market_odds, model_prob:top.model_prob, bookmakers_count:1 };
    }
  }
  if (best) best.bookmakers_count=Math.max(1,books);
  return best;
}
function bestHTFT(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  for (const b of bookmakers||[]){
    const nm=norm(b.name);
    if (!nm || /special/i.test(nm)) continue;
    for (const bet of b.bets||[]){
      const nm=norm(bet.name);
      if (!(nm.includes("ht/ft")||nm.includes("half time/full time"))) continue;
      books++;
      const vals=bet.values||[];
      const cand=vals.map(v=>({ label:v.value, odd:parseFloat(v.odd) }))
                     .filter(x=>isFinite(x.odd) && x.odd>=minOdds)
                     .map(x=>({ ...x, p:1/x.odd }));
      if (!cand.length) continue;
      const S=cand.reduce((a,x)=>a+x.p,0)||1;
      cand.forEach(x=>x.p/=S);
      cand.sort((a,b)=>b.p-a.p);
      const pick=cand[0];
      if (!best || pick.p>best.model_prob || (Math.abs(pick.p-best.model_prob)<1e-9 && pick.odd<best.market_odds))
        best={ market:"HT/FT", selection:pick.label, market_odds:pick.odd, model_prob:pick.p, bookmakers_count:1 };
    }
  }
  if (best) best.bookmakers_count=Math.max(1,books);
  return best;
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  try{
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const slot = (String(q.slot||"").trim().toLowerCase() || deriveSlot(hourInTZ(now, TZ)));
    const wantDebug = String(q.debug||"") === "1" || String(q.debug||"").toLowerCase() === "true";
    const diag = wantDebug ? { reads:[], writes:[] } : null;

    // 0) Preferiraj već pripremljene liste (slot → union → last)
    const prefer = [
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`
    ];
    let rawArr = null, src = null;
    for (const k of prefer){
      const { raw } = await kvGET(k, diag);
      const arr = arrFromAny(J(raw));
      if (arr && arr.length){ rawArr = arr; src = k; break; }
    }

    let items = [];
    let ids = [];

    const isNumericArray = Array.isArray(rawArr) && rawArr.length > 0 &&
      rawArr.every(v => typeof v === "number" || /^\d+$/.test(String(v)));

    if (isNumericArray) {
      ids = rawArr.map(v => Number(v)).filter(Boolean);
    } else if (Array.isArray(rawArr)) {
      items = rawArr.filter(x => x && typeof x === "object");
      ids = items.map(x => Number(x?.fixture_id || x?.id)).filter(Boolean);
    }

    // 1) Slot filter na items; ako posle toga nema ID-eva → F A L L B A C K na fixtures for date
    if (items.length) {
      items = items
        .filter(x => !isYouthOrBanned(x))
        .filter(x => {
          const iso = x?.kickoff_utc || x?.kickoff || x?.datetime_local?.starting_at?.date_time || x?.fixture?.date;
          return iso ? slotForKickoffISO(iso) === slot : true;
        });
      const byId0 = new Map(items.map(x => [Number(x.fixture_id || x.id), x]));
      ids = ids.filter(id => byId0.has(id));
    }
    if (!ids.length) {
      // Fallback: povuci sve fixtures za dan i zadrži samo tekući slot
      const fixtures = await fetchAllFixturesForDate(ymd);
      const slotFx = fixtures.filter(fx => {
        const iso = fx?.fixture?.date;
        return iso ? slotForKickoffISO(iso) === slot : false;
      });
      items = slotFx.map(mapFixtureToItem);
      ids = items.map(it => it.fixture_id).filter(Boolean);
      src = src || "fixtures:fallback";
    }

    // 2) Ako i dalje nema ništa, upiši prazno ali vrati counts
    if (!ids.length) {
      await kvSET(`vb:day:${ymd}:${slot}`, JSON.stringify({ value: JSON.stringify([]) }), diag);
      await kvSET(`vbl_full:${ymd}:${slot}`, JSON.stringify([]), diag);
      await kvSET(`vbl:${ymd}:${slot}`, JSON.stringify([]), diag);
      await kvSET(`tickets:${ymd}:${slot}`, JSON.stringify({ btts:[], ou25:[], htft:[] }), diag);
      return res.status(200).json({
        ok:true, ymd, slot,
        counts:{ base:(rawArr||[]).length||0, after_filters:0, odds_called:0, filled:0 },
        source: src || "empty"
      });
    }

    // 3) /odds po fixture-u (AF) i formiranje 1X2 + tiketa
    const byId = new Map(items.map(x => [x.fixture_id, x]));
    let called=0, filled=0;
    const tickets = { btts:[], ou25:[], htft:[] };

    const lane = async subset=>{
      for (const id of subset){
        if (!byId.has(id)) continue;
        try{
          const jo = await afFetch("/odds",{ fixture:id }, afOddsHeaders());
          called++;
          const bookmakers = jo?.response?.[0]?.bookmakers || [];

          const b1 = best1x2(bookmakers, MIN_ODDS);
          if (b1){
            const it = byId.get(id) || { fixture_id:id };
            it.selection_label = b1.pick;
            it.pick = b1.pick;
            it.pick_code = b1.pick_code || (b1.pick==="Home"?"1":b1.pick==="Draw"?"X":"2");
            it.model_prob = b1.model_prob;
            it.confidence_pct = Math.round(100*b1.model_prob);
            it.odds = { price:b1.odds.price, books_count:b1.odds.books_count||1 };
            byId.set(id, it);
            filled++;
          }

          const baseMeta = byId.get(id) || { fixture_id:id };
          const bookmakers_count = (bookmakers||[]).length || 1;

          const btts = bestBTTS(bookmakers, MIN_ODDS);
          if (btts) tickets.btts.push({ ...baseMeta, market:"BTTS", market_label:"Both Teams To Score",
            selection:btts.selection, market_odds:btts.market_odds, model_prob:btts.model_prob,
            implied_prob:implied(btts.market_odds), confidence_pct:Math.round(100*btts.model_prob),
            bookmakers_count:btts.bookmakers_count||bookmakers_count });

          const ou25 = bestOU25(bookmakers, MIN_ODDS);
          if (ou25) tickets.ou25.push({ ...baseMeta, market:"OU 2.5", market_label:"Over/Under 2.5",
            selection:ou25.selection, market_odds:ou25.market_odds, model_prob:ou25.model_prob,
            implied_prob:implied(ou25.market_odds), confidence_pct:Math.round(100*ou25.model_prob),
            bookmakers_count:ou25.bookmakers_count||bookmakers_count });

          const htft = bestHTFT(bookmakers, MIN_ODDS);
          if (htft) tickets.htft.push({ ...baseMeta, market:"HT/FT", market_label:"HT-FT",
            selection:htft.selection, market_odds:htft.market_odds, model_prob:htft.model_prob,
            implied_prob:implied(htft.market_odds), confidence_pct:Math.round(100*htft.model_prob),
            bookmakers_count:htft.bookmakers_count||bookmakers_count });
        }catch(e){ /* ignore per-fixture fail */ }
      }
    };

    const CHUNK = Math.ceil((ids.length||1)/LANES);
    const parts=[]; for (let i=0;i<ids.length;i+=CHUNK) parts.push(ids.slice(i,i+CHUNK));
    await Promise.all(parts.map(lane));

    const withPicks = Array.from(byId.values())
      .filter(x=>x?.odds?.price && x?.model_prob)
      .sort((a,b)=> (scoreForSort(b)-scoreForSort(a)) || (Date.parse(a.kickoff_utc||0)-Date.parse(b.kickoff_utc||0)) );
    const shortList = withPicks.slice(0, TARGET_N);

    // Upisi po slotu
    await kvSET(`vb:day:${ymd}:${slot}`, JSON.stringify({ value: JSON.stringify(withPicks) }), diag);

    const prevUnionRaw = (await kvGET(`vb:day:${ymd}:union`, diag)).raw;
    const prevUnionArr = arrFromAny(J(prevUnionRaw)) || [];
    const unionBag = new Map();
    for (const it of [...prevUnionArr, ...withPicks]){
      const fid=Number(it?.fixture_id); if (!fid) continue;
      if (!unionBag.has(fid)) unionBag.set(fid,it);
    }
    await kvSET(`vb:day:${ymd}:union`, JSON.stringify({ value: JSON.stringify(Array.from(unionBag.values())) }), diag);

    if (withPicks.length) {
      await kvSET(`vb:day:${ymd}:last`, JSON.stringify({ value: JSON.stringify(withPicks) }), diag);
    }
    await kvSET(`vbl_full:${ymd}:${slot}`, JSON.stringify(withPicks), diag);
    await kvSET(`vbl:${ymd}:${slot}`, JSON.stringify(shortList), diag);

    // tiketi (slot → per-slot + dnevni merge)
    const sortT = (a,b)=> (scoreForSort(b)-scoreForSort(a)) || (Date.parse(a.kickoff_utc||0)-Date.parse(b.kickoff_utc||0));
    const slotTickets = {
      btts: (tickets.btts||[]).sort(sortT).slice(0,TICKETS_PER_MARKET),
      ou25: (tickets.ou25||[]).sort(sortT).slice(0,TICKETS_PER_MARKET),
      htft: (tickets.htft||[]).sort(sortT).slice(0,TICKETS_PER_MARKET),
    };
    await kvSET(`tickets:${ymd}:${slot}`, JSON.stringify(slotTickets), diag);

    const dayRaw = (await kvGET(`tickets:${ymd}`, diag)).raw;
    const dayObj = dayRaw ? J(dayRaw) : { btts:[], ou25:[], htft:[] };
    const merge = (oldArr, addArr)=>{
      const bag=new Map();
      for (const it of [...(oldArr||[]), ...(addArr||[])]){ const fid=Number(it?.fixture_id); if(!fid) continue; if(!bag.has(fid)) bag.set(fid,it); }
      return Array.from(bag.values()).sort(sortT).slice(0,TICKETS_PER_MARKET);
    };
    await kvSET(`tickets:${ymd}`, JSON.stringify({
      btts: merge(dayObj.btts, slotTickets.btts),
      ou25: merge(dayObj.ou25, slotTickets.ou25),
      htft: merge(dayObj.htft, slotTickets.htft),
    }), diag);

    const debugBlock = wantDebug ? {
      diag,
      vbl: {
        kept: withPicks.length,
        returned: shortList.length,
        tickets: {
          slot_btts: slotTickets.btts.length,
          slot_ou25: slotTickets.ou25.length,
          slot_htft: slotTickets.htft.length,
        },
      }
    } : {};

    return res.status(200).json({
      ok:true, ymd, slot,
      counts:{ base:(rawArr||[]).length||0, after_filters:items.length, odds_called:ids.length, filled },
      source: src || "fixtures:fallback",
      ...debugBlock
    });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
