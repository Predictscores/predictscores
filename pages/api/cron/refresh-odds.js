// pages/api/cron/refresh-odds.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo TZ_DISPLAY) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{ headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) {
      trace && trace.push({ get:key, ok:false, err:String(e?.message||e) });
    }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value, trace) {
  const saved = [];
  const body = (typeof value === "string") ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{
        method:"POST", headers:{ Authorization:`Bearer ${b.tok}`, "Content-Type":"application/json" }, cache:"no-store", body
      });
      saved.push({ flavor:b.flavor, ok:r.ok });
    } catch (e) { saved.push({ flavor:b.flavor, ok:false, err:String(e?.message||e) }); }
  }
  trace && trace.push({ set:key, saved }); return saved;
}

/* ---------- utils ---------- */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const arrFromAny = x => Array.isArray(x) ? x
  : (x && typeof x==="object" && Array.isArray(x.items)) ? x.items
  : (x && typeof x==="object" && Array.isArray(x.football)) ? x.football
  : (x && typeof x==="object" && Array.isArray(x.list)) ? x.list
  : [];
const canonicalSlot = x=>{ x=String(x||"auto").toLowerCase(); return (x==="late"||x==="am"||x==="pm")?x:"auto"; };
const autoSlot = (d,tz)=>{ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); };
const targetYmdForSlot = (now,slot,tz)=>{ const h=hourInTZ(now,tz);
  if (slot==="late") return ymdInTZ(h<10?now:addDays(now,1), tz);
  if (slot==="am")   return ymdInTZ(h<15?now:addDays(now,1), tz);
  if (slot==="pm")   return ymdInTZ(h<15?now:addDays(now,1), tz);
  return ymdInTZ(now, tz);
};

/* ---------- trusted / stats ---------- */
const strip = s => String(s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[\W_]+/g,"").toLowerCase();
const keyTeams = (home,away)=> `${strip(home)}__${strip(away)}`;
const TRUSTED = (() => {
  const env = String(process.env.TRUSTED_BOOKIES||"").split(",").map(s=>strip(s));
  const def = ["bet365","pinnacle","williamhill","marathonbet","unibet","888sport","skybet","betfair","betway","ladbrokes","coral","bwin","leon","parimatch","10bet"].map(strip);
  return new Set((env.length?env:def).filter(Boolean));
})();
const median = arr => {
  const a = (arr||[]).filter(n=>Number.isFinite(n)).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
};
function trimMedian(values){
  const a=(values||[]).filter(Number.isFinite).sort((x,y)=>x-y);
  if (a.length<=2) return median(a);
  const cut=Math.max(1, Math.floor(a.length*0.2));
  return median(a.slice(cut, a.length-cut));
}

/* ---------- OA helpers (backup; ≤15/dan) ---------- */
const OA_DAILY_CAP = Number.isFinite(Number(process.env.ODDS_API_DAILY_CAP)) ? Number(process.env.ODDS_API_DAILY_CAP) : 15;

async function oaRemaining(ymd, trace){
  const key = `oa:used:${ymd}`;
  const { raw } = await kvGETraw(key, trace);
  const used = Number(raw||0) || 0;
  return { used, remaining: Math.max(0, OA_DAILY_CAP - used), key };
}
async function oaConsume(ymd, n, trace){
  const { used, key } = await oaRemaining(ymd, trace);
  const next = used + n;
  await kvSET(key, String(next), trace);
  return next;
}
function slotWindowUTC(now, slot, tz) {
  const d = new Date(now);
  const dayYmd = targetYmdForSlot(now, slot, tz);
  const [Y,M,D] = dayYmd.split("-").map(Number);
  const base = new Date(Date.UTC(Y, M-1, D, 0, 0, 0));
  const addH = (h)=> new Date(base.getTime() + h*3600*1000);
  let fromH=0, toH=24;
  if (slot==="late") { fromH=0; toH=10; }
  if (slot==="am")   { fromH=10; toH=15; }
  if (slot==="pm")   { fromH=15; toH=24; }
  return { from:new Date(addH(fromH)), to:new Date(addH(toH)) };
}

function normalizeBookName(name){ return strip(String(name||"")); }
function pullPrice(bookmakers, marketKey, pickPredicate, periodFilter=null) {
  const prices = [];
  for (const bm of (bookmakers||[])) {
    const bn = normalizeBookName(bm?.title);
    if (!TRUSTED.has(bn)) continue;
    for (const mk of (bm?.markets||[])) {
      const key = String(mk?.key||"");
      if (key !== marketKey) continue;
      // pokušaj filtriranja perioda (FH) ako je definisano
      if (periodFilter) {
        const period = String(mk?.description||mk?.name||"").toLowerCase();
        if (!periodFilter(period)) continue;
      }
      for (const out of (mk?.outcomes||[])) {
        if (pickPredicate(out)) {
          const p = Number(out?.price);
          if (Number.isFinite(p)) prices.push(p);
        }
      }
    }
  }
  return trimMedian(prices);
}

function mapOAbyTeams(events){
  const map = new Map();
  for (const ev of (events||[])) {
    const h = ev?.home_team, a = ev?.away_team;
    if (!h || !a) continue;
    const k = keyTeams(h, a);
    (map.get(k) || map.set(k, []).get(k)).push(ev);
  }
  return map;
}
function closestByTime(cands, kickoffISO){
  if (!Array.isArray(cands) || !cands.length) return null;
  if (!kickoffISO) return cands[0];
  const kt = new Date(kickoffISO).getTime();
  let best=cands[0], bestAbs=Infinity;
  for (const ev of cands){
    const t = new Date(ev?.commence_time).getTime();
    const diff = Math.abs((t||0) - kt);
    if (diff < bestAbs) { best = ev; bestAbs = diff; }
  }
  return best;
}

async function fetchOA({ from, to }, trace) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { events:[], called:false, url:null, ok:false };
  const regions = String(process.env.ODDS_API_REGION||"eu").trim() || "eu";
  const qs = new URLSearchParams({
    apiKey: key,
    regions: /\beu\b/i.test(regions) ? "eu,uk" : regions, // dodaj uk radi pokrivenosti
    markets: "h2h,totals,both_teams_to_score,half_time_full_time",
    oddsFormat: "decimal",
    dateFormat: "iso",
    commenceTimeFrom: from.toISOString(),
    commenceTimeTo: to.toISOString()
  });
  const url = `https://api.the-odds-api.com/v4/sports/soccer/odds?${qs.toString()}`;
  try {
    const r = await fetch(url, { cache:"no-store" });
    const data = await r.json().catch(()=>[]);
    const events = Array.isArray(data) ? data : [];
    trace && trace.push({ oa_url:url, oa_ok:r.ok, events:events.length });
    return { events, called:true, ok:r.ok };
  } catch(e) {
    trace && trace.push({ oa_err:String(e?.message||e) });
    return { events:[], called:true, ok:false };
  }
}

/* ---------- sanity kvota ---------- */
function impliedSumOk(prices){
  const inv = (p)=> (Number.isFinite(p)&&p>0)?(1/p):0;
  const s = (prices||[]).map(inv).reduce((a,b)=>a+b,0);
  return s>=0.8 && s<=1.3;
}
function inRange(p, lo, hi){ return Number.isFinite(p) && p>=lo && p<=hi; }

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd   = targetYmdForSlot(now, slot, TZ);

    // Učitaj bazni skup (prefer vbl_full → vb:day:union → vb:day:slot → vbl)
    const tried = [
      `vbl_full:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`
    ];
    let baseArr=null, src=null;
    for (const k of tried) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (arr.length){ src=k; baseArr=arr; break; }
    }
    if (!baseArr) return res.status(200).json({ ok:true, ymd, slot, msg:"no source", oa:{called:false,events:0}, touched_full:0, touched_union:0 });

    // Slot prozor i OA cap
    const windowUTC = slotWindowUTC(now, slot, TZ);
    const { remaining, key:capKey } = await oaRemaining(ymd, trace);
    const maxTargets = Math.min(5, remaining); // ≤5 po slotu

    // Priprema mapiranja OA događaja (samo ako imamo cap)
    let byTeams = new Map();
    if (maxTargets>0) {
      const oa = await fetchOA(windowUTC, trace);
      byTeams = mapOAbyTeams(oa.events||[]);
    }

    // Izaberi targete: prioritet — oni koji imaju kandidaturu za tikete ili prazan market
    // (ograniči na maxTargets; ostalima ne diramo markets)
    const candidates = [];
    for (const it of baseArr) {
      const m = it?.markets||{};
      const needBtts = !Number.isFinite(m?.btts?.yes);
      const needOU25 = !Number.isFinite(m?.ou25?.over);
      const needHTFT = !Number.isFinite(m?.htft?.hh) && !Number.isFinite(m?.htft?.aa);
      const needFH   = !Number.isFinite(m?.fh_ou15?.over);
      if (needBtts || needOU25 || needHTFT || needFH) candidates.push(it);
      if (candidates.length>=maxTargets) break;
    }

    let touched_full=0, touched_union=0, usedOA=0, updated=0;
    // Obradi targete kroz OA (backup)
    for (const it of candidates) {
      const home = it?.teams?.home?.name || it?.home?.name;
      const away = it?.teams?.away?.name || it?.away?.name;
      if (!home || !away) continue;

      const k = keyTeams(home, away);
      const cands = byTeams.get(k) || byTeams.get(keyTeams(away, home)) || [];
      if (!cands.length) continue;
      const match = closestByTime(cands, it?.kickoff_utc || it?.fixture?.date || it?.kickoff);
      if (!match) continue;

      const books = match?.bookmakers || [];
      const markets = it.markets || (it.markets = {});

      // 1X2 (h2h)
      const h   = pullPrice(books, "h2h", o=>String(o?.name).toLowerCase()==="home");
      const d   = pullPrice(books, "h2h", o=>String(o?.name).toLowerCase()==="draw");
      const a   = pullPrice(books, "h2h", o=>String(o?.name).toLowerCase()==="away");
      if ([h,d,a].some(Number.isFinite) && impliedSumOk([h,d,a])) {
        markets.h2h = { home:h??null, draw:d??null, away:a??null };
        updated++;
      }

      // OU 2.5 (totals, Over/Under @2.5)
      const ouO = pullPrice(books, "totals", o=> (Number(o?.point)===2.5) && String(o?.name).toLowerCase()==="over", desc=>/1st|first\s*half/i.test(desc)===false);
      const ouU = pullPrice(books, "totals", o=> (Number(o?.point)===2.5) && String(o?.name).toLowerCase()==="under", desc=>/1st|first\s*half/i.test(desc)===false);
      if ([ouO,ouU].some(Number.isFinite) && impliedSumOk([ouO,ouU]) && inRange(ouO,1.2,5.5) && inRange(ouU,1.2,5.5)) {
        markets.ou25 = { over:ouO??null, under:ouU??null };
        updated++;
      }

      // BTTS yes
      const bttsY = pullPrice(books, "both_teams_to_score", o=>/yes/i.test(String(o?.name)));
      const bttsN = pullPrice(books, "both_teams_to_score", o=>/no/i.test(String(o?.name)));
      if ([bttsY,bttsN].some(Number.isFinite) && impliedSumOk([bttsY,bttsN]) && inRange(bttsY,1.25,5.0)) {
        markets.btts = { yes:bttsY??null, no:bttsN??null };
        updated++;
      }

      // HT-FT (kao predstavnici HH/AA)
      const htftHH = pullPrice(books, "half_time_full_time", o=>/home\/home/i.test(String(o?.name)));
      const htftAA = pullPrice(books, "half_time_full_time", o=>/away\/away/i.test(String(o?.name)));
      if ([htftHH,htftAA].some(Number.isFinite) && inRange(htftHH??3,3,40) || inRange(htftAA??3,3,40)) {
        markets.htft = { hh:htftHH??null, aa:htftAA??null };
        updated++;
      }

      // FH Over 1.5 (totals @1.5, ali samo za 1st half)
      const fhO = pullPrice(books, "totals", o=> (Number(o?.point)===1.5) && String(o?.name).toLowerCase()==="over", desc=>/1st|first\s*half/i.test(desc));
      if (Number.isFinite(fhO) && inRange(fhO,1.2,5.0)) {
        markets.fh_ou15 = { over: fhO, books_count: (markets.fh_ou15?.books_count||0) };
        updated++;
      }

      touched_full++;
      usedOA++;
      if (usedOA >= maxTargets) break;
    }

    // Snimi nazad u vbl_full
    if (updated>0) await kvSET(`vbl_full:${ymd}:${slot}`, { items: baseArr }, trace);

    // Pokušaj propagacije u union (po fixture_id)
    const { raw:rawUnion } = await kvGETraw(`vb:day:${ymd}:union`, trace);
    const unionArr = arrFromAny(J(rawUnion));
    if (updated>0 && unionArr.length) {
      const byFix = new Map();
      for (const it of baseArr) if (it?.fixture_id || it?.fixture?.id) byFix.set(String(it.fixture_id||it?.fixture?.id), it);
      for (const u of unionArr) {
        const fix = u?.fixture_id && byFix.get(String(u.fixture_id));
        if (fix?.markets) { u.markets = { ...u.markets, ...fix.markets }; touched_union++; }
      }
      await kvSET(`vb:day:${ymd}:union`, { items: unionArr }, trace);
    }

    // Upiši OA potrošnju samo ako smo stvarno koristili targete (ne brojimo prazne/greške)
    if (usedOA>0) await oaConsume(ymd, usedOA, trace);

    return res.status(200).json({
      ok:true, ymd, slot, source:src,
      touched_full, touched_union, updated, oa_used: usedOA, oa_cap_left: Math.max(0, OA_DAILY_CAP - (await oaRemaining(ymd, trace)).used),
      debug: { trace }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
