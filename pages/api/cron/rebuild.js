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
  const list = [];
  if (url && rw) list.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) list.push({ flavor: "vercel-kv:ro", url, token: ro });
  return list;
}
async function kvGET(key, diag){
  for (const c of kvCfgs()){
    try{
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers:{ Authorization:`Bearer ${c.token}` },
        cache:"no-store",
      });
      const j = r.ok ? await r.json().catch(()=>null) : null;
      const raw = j && typeof j.result==="string" ? j.result : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status: r.ok ? (raw?"hit":"miss-null") : `http-${r.status}` });
      if (raw) return { raw, flavor:c.flavor };
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
function unpack(raw){
  if (!raw || typeof raw!=="string") return null;
  let v = J(raw);
  if (Array.isArray(v)) return v;
  if (v && typeof v==="object" && "value" in v){
    if (Array.isArray(v.value)) return v.value;
    if (typeof v.value==="string"){ const v2=J(v.value); if (Array.isArray(v2)) return v2; if (v2&&typeof v2==="object") return arrFromAny(v2); }
    return null;
  }
  if (v && typeof v==="object") return arrFromAny(v);
  return null;
}

/* ---------- time/slot helpers ---------- */
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

async function afFetch(path, params={}, headers=afFixturesHeaders()){
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers, cache:"no-store" });
  const t = await r.text();
  let j=null; try{ j=JSON.parse(t);}catch{}
  if (!j) throw new Error(`AF parse error ${r.status}`);
  return j;
}
function mapFixtureToItem(fx){
  const id = Number(fx?.fixture?.id);
  const ts = Number(fx?.fixture?.timestamp||0)*1000 || Date.parse(fx?.fixture?.date||0) || 0;
  const kick = new Date(ts).toISOString();
  return {
    fixture_id:id,
    league:{ id:fx?.league?.id, name:fx?.league?.name, country:fx?.league?.country, season:fx?.league?.season },
    league_name:fx?.league?.name,
    league_country:fx?.league?.country,
    teams:{ home:fx?.teams?.home?.name, away:fx?.teams?.away?.name, home_id:fx?.teams?.home?.id, away_id:fx?.teams?.away?.id },
    home:fx?.teams?.home?.name, away:fx?.teams?.away?.name,
    kickoff:(fx?.fixture?.date||"").replace("T"," ").slice(0,16),
    kickoff_utc:kick,
    market:"1X2", market_label:"1X2",
    pick:null, pick_code:null, selection_label:null,
    model_prob:null, confidence_pct:null, odds:null,
    fixture:{ id, timestamp:ts, date:kick },
  };
}

/* ---------- fetch fixtures for date (p0 bez page) ---------- */
async function fetchAllFixturesForDate(ymd){
  const tries = [
    { tag:"date+tz", params:{ date: ymd, timezone: TZ } },
    { tag:"date",    params:{ date: ymd } },
    { tag:"from-to", params:{ from: ymd, to: ymd } },
    { tag:"date+UTC",params:{ date: ymd, timezone: "UTC" } },
  ];
  const bag = new Map();
  for (const t of tries){
    const j0 = await afFetch("/fixtures",{...t.params},afFixturesHeaders());
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0){ const id=fx?.fixture?.id; if(id && !bag.has(id)) bag.set(id, fx); }
    const tot = Number(j0?.paging?.total||1);
    for(let page=2; page<=Math.min(tot,12); page++){
      const j = await afFetch("/fixtures",{...t.params,page},afFixturesHeaders());
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr){ const id=fx?.fixture?.id; if(id && !bag.has(id)) bag.set(id, fx); }
    }
  }
  return Array.from(bag.values());
}

/* ---------- odds pickers ---------- */
function best1x2(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  for (const b of bookmakers||[]){
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
      if (!best || chosen.model_prob>best.model_prob || (Math.abs(chosen.model_prob-best.model_prob)<1e-9 && chosen.odds.price<best.odds.price))
        best=chosen;
    }
  }
  if (best) best.odds.books_count=Math.max(1,books);
  return best;
}
function bestBTTS(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  for (const b of bookmakers||[]){
    for (const bet of b.bets||[]){
      const nm=String(bet.name||"").toLowerCase();
      if (!(nm.includes("both teams to score")||nm.includes("btts"))) continue;
      books++;
      const vals=bet.values||[];
      const y=vals.find(v=>/yes/i.test(v.value||""));
      const n=vals.find(v=>/no/i.test(v.value||""));
      const oY=y?parseFloat(y.odd):NaN, oN=n?parseFloat(n.odd):NaN;
      const hasY=isFinite(oY), hasN=isFinite(oN);
      if (!hasY && !hasN) continue;
      const pY=hasY?1/oY:0, pN=hasN?1/oN:0, S=pY+pN||1;
      const c=[]; if (hasY&&oY>=minOdds) c.push({sel:"Yes",odd:oY,prob:pY/S}); if (hasN&&oN>=minOdds) c.push({sel:"No",odd:oN,prob:pN/S});
      if (!c.length) continue;
      c.sort((a,b)=>b.prob-a.prob);
      const pick=c[0];
      if (!best || pick.prob>best.model_prob || (Math.abs(pick.prob-best.model_prob)<1e-9 && pick.odd<best.market_odds))
        best={ market:"BTTS", selection:pick.sel, market_odds:pick.odd, model_prob:pick.prob, bookmakers_count:1 };
    }
  }
  if (best) best.bookmakers_count=Math.max(1,books);
  return best;
}
function bestOU25(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  const has25=s=>/\b2\.5\b/.test(String(s||""));
  for (const b of bookmakers||[]){
    for (const bet of b.bets||[]){
      const nm=String(bet.name||"").toLowerCase();
      if (!(nm.includes("over/under")||nm.includes("total"))) continue;
      const vals=bet.values||[];
      const candOver=vals.find(v=>/over/i.test(v.value||"")&&(has25(v.value)||has25(v.handicap)));
      const candUnder=vals.find(v=>/under/i.test(v.value||"")&&(has25(v.value)||has25(v.handicap)));
      const oO=candOver?parseFloat(candOver.odd):NaN, oU=candUnder?parseFloat(candUnder.odd):NaN;
      const hasO=isFinite(oO), hasU=isFinite(oU);
      if (!hasO && !hasU) continue;
      books++;
      const pO=hasO?1/oO:0, pU=hasU?1/oU:0, S=pO+pU||1;
      const c=[]; if (hasO&&oO>=minOdds) c.push({sel:"Over 2.5",odd:oO,prob:pO/S}); if (hasU&&oU>=minOdds) c.push({sel:"Under 2.5",odd:oU,prob:pU/S});
      if (!c.length) continue;
      c.sort((a,b)=>b.prob-a.prob);
      const pick=c[0];
      if (!best || pick.prob>best.model_prob || (Math.abs(pick.prob-best.model_prob)<1e-9 && pick.odd<best.market_odds))
        best={ market:"OU 2.5", selection:pick.sel, market_odds:pick.odd, model_prob:pick.prob, bookmakers_count:1 };
    }
  }
  if (best) best.bookmakers_count=Math.max(1,books);
  return best;
}
function bestHTFT(bookmakers,minOdds=MIN_ODDS){
  let best=null, books=0;
  const norm=s=>String(s||"").toLowerCase();
  for (const b of bookmakers||[]){
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
function slotForKickoffISO(iso){
  const h = new Date(iso).toLocaleString("en-GB",{ hour:"2-digit", hour12:false, timeZone:TZ });
  return deriveSlot(parseInt(h,10));
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  try{
    const now = new Date();
    const ymd  = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
    const wantDebug = String(q.debug ?? "") === "1";
    const diag = wantDebug ? {} : null;

    // Kandidati iz KV
    const prefer = [
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `fixtures:${ymd}:${slot}`
    ];
    let rawArr = null, src = null;
    for (const k of prefer){
      const { raw } = await kvGET(k, diag);
      const arr = arrFromAny(unpack(raw));
      if (arr && arr.length){ rawArr = arr; src = k; break; }
    }

    // --- NOVO: ako je stigla lista brojeva (ID-jevi), izgradi meta pa radi /odds ---
    let items = [];
    let ids = [];

    const isNumericArray = Array.isArray(rawArr) && rawArr.length > 0 &&
      rawArr.every(v => typeof v === "number" || /^\d+$/.test(String(v)));

    if (isNumericArray) {
      ids = rawArr.map(v => Number(v)).filter(Boolean);
      // uzmi sve fixturе za dan i upari
      const fixtures = await fetchAllFixturesForDate(ymd);
      const byIdMeta = new Map(fixtures.map(fx => [Number(fx?.fixture?.id), mapFixtureToItem(fx)]));
      items = ids.map(id => byIdMeta.get(id) || { fixture_id:id, kickoff_utc:null, home:null, away:null, league_name:null });
    } else {
      // očekujemo listu objekata
      items = (rawArr || []).filter(x => x && typeof x === "object");
      ids = items.map(x => Number(x?.fixture_id || x?.id)).filter(Boolean);
    }

    // filteri + mape
    items = (items || []).filter(x => !isYouthOrBanned(x));
    const byId = new Map(items.map(x => [x.fixture_id, x]));

    const tickets = { btts:[], ou25:[], htft:[] };
    let called=0, filled=0;

    const lane = async subset=>{
      for (const id of subset){
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
          const base = {
            fixture_id:id,
            league:baseMeta.league, league_name:baseMeta.league_name, league_country:baseMeta.league_country,
            teams:baseMeta.teams, home:baseMeta.home, away:baseMeta.away,
            kickoff:baseMeta.kickoff, kickoff_utc:baseMeta.kickoff_utc,
          };

          const btts = bestBTTS(bookmakers, MIN_ODDS);
          if (btts) tickets.btts.push({ ...base, market:"BTTS", market_label:"Both Teams To Score",
            selection:btts.selection, market_odds:btts.market_odds, model_prob:btts.model_prob,
            implied_prob:implied(btts.market_odds), confidence_pct:Math.round(100*btts.model_prob),
            bookmakers_count:btts.bookmakers_count||1 });

          const ou25 = bestOU25(bookmakers, MIN_ODDS);
          if (ou25) tickets.ou25.push({ ...base, market:"OU 2.5", market_label:"Over/Under 2.5",
            selection:ou25.selection, market_odds:ou25.market_odds, model_prob:ou25.model_prob,
            implied_prob:implied(ou25.market_odds), confidence_pct:Math.round(100*ou25.model_prob),
            bookmakers_count:ou25.bookmakers_count||1 });

          const htft = bestHTFT(bookmakers, MIN_ODDS);
          if (htft) tickets.htft.push({ ...base, market:"HT/FT", market_label:"HT-FT",
            selection:htft.selection, market_odds:htft.market_odds, model_prob:htft.model_prob,
            implied_prob:implied(htft.market_odds), confidence_pct:Math.round(100*htft.model_prob),
            bookmakers_count:htft.bookmakers_count||1 });
        }catch(e){ /* ignore per-fixture fail */ }
      }
    };

    // paralelno /odds
    const CHUNK = Math.ceil((ids.length||1)/LANES);
    const parts=[]; for (let i=0;i<ids.length;i+=CHUNK) parts.push(ids.slice(i,i+CHUNK));
    await Promise.all(parts.map(lane));

    const withPicks = Array.from(byId.values())
      .filter(x=>x?.odds?.price && x?.model_prob)
      .sort((a,b)=> (scoreForSort(b)-scoreForSort(a)) || (Date.parse(a.kickoff_utc||0)-Date.parse(b.kickoff_utc||0)) );
    const shortList = withPicks.slice(0, TARGET_N);

    // Upisi
    await kvSET(`vb:day:${ymd}:${slot}`, JSON.stringify({ value: JSON.stringify(withPicks) }), diag);
    const prevUnionRaw = (await kvGET(`vb:day:${ymd}:union`, diag)).raw;
    const prevUnionArr = arrFromAny(unpack(prevUnionRaw)) || [];
    const unionBag = new Map();
    for (const it of [...prevUnionArr, ...withPicks]){ const fid=Number(it?.fixture_id); if (!fid) continue; if (!unionBag.has(fid)) unionBag.set(fid,it); }
    await kvSET(`vb:day:${ymd}:union`, JSON.stringify({ value: JSON.stringify(Array.from(unionBag.values())) }), diag);
    if (withPicks.length) await kvSET(`vb:day:${ymd}:last`, JSON.stringify({ value: JSON.stringify(withPicks) }), diag);
    await kvSET(`vbl_full:${ymd}:${slot}`, JSON.stringify(withPicks), diag);
    await kvSET(`vbl:${ymd}:${slot}`, JSON.stringify(shortList), diag);

    // combined top3
    const top3 = withPicks.slice(0,3);
    const prevC = (await kvGET(`vb:day:${ymd}:combined`, diag)).raw;
    const prevA = arrFromAny(unpack(prevC)) || [];
    const dedup = new Map();
    for (const it of [...prevA, ...top3]){ const fid=Number(it?.fixture_id); if (!fid) continue; if (!dedup.has(fid)) dedup.set(fid,it); }
    const merged = Array.from(dedup.values()).sort((a,b)=>scoreForSort(b)-scoreForSort(a)).slice(0,3);
    await kvSET(`vb:day:${ymd}:combined`, JSON.stringify({ value: JSON.stringify(merged) }), diag);

    // tickets (po slotu + dnevno)
    const sortT=(a,b)=> (b.confidence_pct-a.confidence_pct) || (Date.parse(a.kickoff_utc||0)-Date.parse(b.kickoff_utc||0));
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

    // debug blok
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
      counts:{ base:(rawArr||[]).length, after_filters:(items||[]).length, odds_called:ids.length, filled },
      source: src || "built",
      ...debugBlock
    });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
