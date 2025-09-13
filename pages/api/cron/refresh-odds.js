// pages/api/cron/refresh-odds.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo TZ_DISPLAY) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV backends (Vercel KV / Upstash) ---------- */
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

/* ---------- name/median helpers ---------- */
const strip = s => String(s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[\W_]+/g,"").toLowerCase();
const keyTeams = (home,away)=> `${strip(home)}__${strip(away)}`;
const median = arr => {
  const a = (arr||[]).filter(n=>Number.isFinite(n)).sort((x,y)=>x-y);
  if (!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
};
const TRUSTED = new Set(["bet365","pinnacle","williamhill","marathonbet","unibet","888sport","skybet","betfair","betway","ladbrokes","coral","bwin","leon","parimatch","10bet"].map(strip));

/* ---------- OA ---------- */
function slotWindowUTC(now, slot, tz) {
  // grubi prozori za OA (minimizujemo listu)
  const d = new Date(now);
  const dayYmd = targetYmdForSlot(now, slot, tz);
  const [Y,M,D] = dayYmd.split("-").map(Number);
  // lokalan početak dana u TZ
  const startLocal = new Date(Date.UTC(Y, M-1, D, 0, 0, 0));
  const base = new Date(startLocal); // kao UTC nosilac
  const addH = (h)=> new Date(base.getTime() + h*3600*1000);
  let fromH=0, toH=24;
  if (slot==="late") { fromH=0; toH=10; }
  if (slot==="am")   { fromH=10; toH=15; }
  if (slot==="pm")   { fromH=15; toH=24; }
  return { from:new Date(addH(fromH)), to:new Date(addH(toH)) };
}

async function fetchOA({ from, to }, trace) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { events:[], called:false, url:null, ok:false };
  const qs = new URLSearchParams({
    apiKey: key,
    regions: "eu,uk",
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
    return { events, called:true, url, ok:r.ok };
  } catch(e) {
    trace && trace.push({ oa_err:String(e?.message||e) });
    return { events:[], called:true, url, ok:false };
  }
}

function normalizeBookName(name){ return strip(String(name||"")); }

function pullPriceFromBookmakers(bookmakers, marketKey, pickPredicate) {
  const prices = [];
  for (const bm of (bookmakers||[])) {
    const bn = normalizeBookName(bm?.title);
    if (!TRUSTED.has(bn)) continue;
    for (const mk of (bm?.markets||[])) {
      const mtype = String(mk?.key||"");
      if (mtype !== marketKey) continue;
      for (const out of (mk?.outcomes||[])) {
        if (pickPredicate(out)) {
          const p = Number(out?.price);
          if (Number.isFinite(p)) prices.push(p);
        }
      }
    }
  }
  return median(prices);
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

/* ---------- handler ---------- */
export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd   = targetYmdForSlot(now, slot, TZ);

    // izvori
    const tried = [
      `vbl_full:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vbl:${ymd}:${slot}`
    ];
    let src=null, baseArr=null;
    for (const k of tried) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (arr.length){ src=k; baseArr=arr; break; }
    }
    if (!baseArr) {
      return res.status(200).json({ ok:true, ymd, slot, msg:"no vbl_full nor union", saves:false, oa:{ called:false, used_before:0, used_after:0, events:0 } });
    }

    // OA fetch u slot prozoru
    const windowUTC = slotWindowUTC(now, slot, TZ);
    const oa = await fetchOA(windowUTC, trace);
    const events = oa.events || [];
    const byTeams = mapOAbyTeams(events);

    let inspected = 0, touched_full = 0, touched_union = 0;

    // helper za zapis nazad (čuvamo kao {items:[...]})
    async function saveBack(key, arr) {
      return kvSET(key, { items: arr }, trace);
    }

    // obradimo samo onoliko koliko imamo u baseArr
    for (const it of baseArr) {
      inspected++;
      const home = it?.teams?.home?.name || it?.home?.name;
      const away = it?.teams?.away?.name || it?.away?.name;
      if (!home || !away) continue;

      const k = keyTeams(home, away);
      const cands = byTeams.get(k) || byTeams.get(keyTeams(away, home)) || [];
      if (!cands.length) continue;
      const match = closestByTime(cands, it?.kickoff_utc || it?.fixture?.date || it?.kickoff);

      if (!match) continue;

      const books = match?.bookmakers || [];

      // 1X2 (h2h)
      const h2hHome = pullPriceFromBookmakers(books, "h2h", o=>String(o?.name).toLowerCase()==="home");
      const h2hDraw = pullPriceFromBookmakers(books, "h2h", o=>String(o?.name).toLowerCase()==="draw");
      const h2hAway = pullPriceFromBookmakers(books, "h2h", o=>String(o?.name).toLowerCase()==="away");

      // O/U 2.5 (totals, point=2.5, Over)
      const ouOver = pullPriceFromBookmakers(books, "totals", o=> (Number(o?.point)===2.5) && String(o?.name).toLowerCase()==="over");
      const ouUnder = pullPriceFromBookmakers(books, "totals", o=> (Number(o?.point)===2.5) && String(o?.name).toLowerCase()==="under");

      // BTTS yes
      const bttsYes = pullPriceFromBookmakers(books, "both_teams_to_score", o=>String(o?.name).toLowerCase().includes("yes"));

      // HT-FT (Home/Home & Away/Away kao reprezentativni)
      const htftHH = pullPriceFromBookmakers(books, "half_time_full_time", o=>String(o?.name).toLowerCase().includes("home/home"));
      const htftAA = pullPriceFromBookmakers(books, "half_time_full_time", o=>String(o?.name).toLowerCase().includes("away/away"));

      it.markets = it.markets || {};
      it.markets.h2h  = { home:h2hHome, draw:h2hDraw, away:h2hAway };
      it.markets.ou25 = { over:ouOver, under:ouUnder };
      it.markets.btts = { yes:bttsYes };
      it.markets.htft = { hh:htftHH, aa:htftAA };

      touched_full++;
    }

    // snimimo nazad u vbl_full:<ymd>:<slot>
    const saves = await saveBack(`vbl_full:${ymd}:${slot}`, baseArr);

    // ako postoji union, pokušaj propagaciju (po fixture_id match-u)
    const { raw:rawUnion } = await kvGETraw(`vb:day:${ymd}:union`, trace);
    const unionArr = arrFromAny(J(rawUnion));
    if (unionArr.length) {
      const byFix = new Map();
      for (const it of baseArr) if (it?.fixture_id) byFix.set(String(it.fixture_id), it);
      for (const u of unionArr) {
        const fix = u?.fixture_id && byFix.get(String(u.fixture_id));
        if (fix?.markets) { u.markets = { ...u.markets, ...fix.markets }; touched_union++; }
      }
      await saveBack(`vb:day:${ymd}:union`, unionArr);
    }

    return res.status(200).json({
      ok:true, ymd, slot,
      source: (src||"full").includes("vbl_full") ? "full" : (src||"union"),
      inspected_full: inspected,
      touched_full, touched_union,
      saves, oa: { called: oa.called, events: events.length }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
