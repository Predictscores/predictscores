// pages/api/cron/refresh-odds.js

export const config = { api: { bodyParser: false } };

const TZ = (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) || "Europe/Belgrade";

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
async function kvGET(key, diag) {
  for (const c of kvCfgs()) {
    try {
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` },
        cache: "no-store",
      });
      const j = r.ok ? await r.json().catch(()=>null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status: r.ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` });
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, valueString, diag) {
  const saved = [];
  for (const c of kvCfgs().filter(x=>x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type":"application/json" },
        cache: "no-store",
        body: valueString,
      });
      saved.push({ flavor:c.flavor, ok:r.ok });
    } catch (e) {
      saved.push({ flavor:c.flavor, ok:false, err:String(e?.message||e) });
    }
  }
  diag && (diag.writes = diag.writes || []).push({ key, saved });
  return saved;
}
const J = s => { try { return JSON.parse(String(s||"")); } catch { return null; } };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object") {
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value === "string") { const v = J(x.value); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
  }
  if (typeof x === "string") { const v = J(x); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
  return null;
}
function unpack(raw){
  if (!raw || typeof raw!=="string") return null;
  let v = J(raw);
  if (Array.isArray(v)) return v;
  if (v && typeof v==="object" && "value" in v){
    if (Array.isArray(v.value)) return v.value;
    if (typeof v.value === "string"){ const v2 = J(v.value); if (Array.isArray(v2)) return v2; if (v2 && typeof v2==="object") return arrFromAny(v2); }
    return null;
  }
  if (v && typeof v==="object") return arrFromAny(v);
  return null;
}

/* ---------- time/slot ---------- */
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
function slotForKickoffISO(iso){
  const h = new Date(iso).toLocaleString("en-GB",{ hour:"2-digit", hour12:false, timeZone:TZ });
  return deriveSlot(parseInt(h,10));
}
function isYouthOrBanned(item){
  const ln = (item?.league_name || item?.league?.name || "").toString();
  const tnH = (item?.home || item?.teams?.home?.name || "").toString();
  const tnA = (item?.away || item?.teams?.away?.name || "").toString();
  const s = `${ln} ${tnH} ${tnA}`;
  return /\bU(-|\s)?(17|18|19|20|21|22|23)\b/i.test(s) || /\bPrimavera\b/i.test(s) || /\bYouth\b/i.test(s);
}

/* ---------- API-Football ---------- */
const AF_BASE = "https://v3.football.api-sports.io";
const afFixturesHeaders = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim() });
const afOddsHeaders     = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim() }); // <<<<< ključno

async function afFetch(path, params={}, headers=afFixturesHeaders(), diagTag, diag){
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers, cache:"no-store" });
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  if (diag) (diag.af = diag.af || []).push({ host: AF_BASE, tag: diagTag, path, params, status: r.status, ok: r.ok, results: j?.results, errors: j?.errors });
  return j || {};
}
function mapFixture(fx){
  const id = Number(fx?.fixture?.id);
  const ts = Number(fx?.fixture?.timestamp||0)*1000 || Date.parse(fx?.fixture?.date||0) || 0;
  const kick = new Date(ts).toISOString();
  return {
    fixture_id: id,
    league_name: fx?.league?.name,
    teams: { home: fx?.teams?.home?.name, away: fx?.teams?.away?.name },
    home: fx?.teams?.home?.name, away: fx?.teams?.away?.name,
    kickoff_utc: kick,
  };
}

/* ---------- fixtures (p0 bez page; paging samo ako treba) ---------- */
async function fetchFixturesIDsByDateStrict(ymd, slot, diag){
  const variants = [
    { tag:"date+tz", params:{ date: ymd, timezone: TZ } },
    { tag:"date",    params:{ date: ymd } },
    { tag:"from-to", params:{ from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants){
    const j0 = await afFetch("/fixtures",{...v.params},afFixturesHeaders(),`fixtures:${v.tag}:p0`,diag);
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    const tot = Number(j0?.paging?.total||1);
    for(let page=2; page<=Math.min(tot,12); page++){
      const j = await afFetch("/fixtures",{...v.params,page},afFixturesHeaders(),`fixtures:${v.tag}:p${page}`,diag);
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}
async function fetchFixturesIDsWholeDay(ymd, slot, diag){
  const variants = [
    { tag:"date+tz", params:{ date: ymd, timezone: TZ } },
    { tag:"date",    params:{ date: ymd } },
    { tag:"from-to", params:{ from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants){
    const j0 = await afFetch("/fixtures",{...v.params},afFixturesHeaders(),`fixtures:${v.tag}:p0`,diag);
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    const tot = Number(j0?.paging?.total||1);
    for(let page=2; page<=Math.min(tot,12); page++){
      const j = await afFetch("/fixtures",{...v.params,page},afFixturesHeaders(),`fixtures:${v.tag}:p${page}`,diag);
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}

/* ---------- odds (API-Football; koristi API_FOOTBALL_KEY) ---------- */
async function refreshOddsForIDs(ids, diag){
  let touched = 0;
  for (const id of ids){
    try{
      const jo = await afFetch("/odds", { fixture:id }, afOddsHeaders(), "odds", diag);
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:Boolean(jo?.response?.length) });
      touched++;
    }catch(e){
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:false, err:String(e?.message||e) });
    }
  }
  return touched;
}

/* ---------- ODDS_API (bulk enrichment; optional) ---------- */
const OA_BASE = (process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4").replace(/\/+$/,"");
const OA_KEY  = (process.env.ODDS_API_KEY || "").trim();
const OA_REGION_STR  = (process.env.ODDS_API_REGION || process.env.ODDS_API_REGIONS || "eu").trim();
const OA_MARKETS_STR = (process.env.ODDS_API_MARKETS || "h2h").trim();
const OA_DAILY_CAP   = Math.max(1, Number(process.env.ODDS_API_DAILY_CAP || 150) || 150); // per-run cap (safety)
const OA_BUDGET_PER_DAY = Math.max(1, Number(process.env.ODDS_API_DAILY_BUDGET || 15) || 15); // hard daily cap

function parseCSV(s){ return String(s||"").split(",").map(x=>x.trim()).filter(Boolean); }
const OA_REGIONS  = parseCSV(OA_REGION_STR);
const OA_MARKETS  = parseCSV(OA_MARKETS_STR);

function slugTeam(s){
  return String(s||"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/\b(fc|fk|afc|sc|ac|cf|club|c\.f\.)\b/g,"")
    .replace(/[^a-z0-9]+/g,"")
    .trim();
}
function median(nums){
  const arr = nums.filter(Number.isFinite).slice().sort((a,b)=>a-b);
  if (!arr.length) return null;
  const m = Math.floor(arr.length/2);
  return arr.length%2 ? arr[m] : (arr[m-1]+arr[m])/2;
}
function noVigImplied(prices){
  const inv = {
    home: prices.home ? 1/ prices.home : 0,
    draw: prices.draw ? 1/ prices.draw : 0,
    away: prices.away ? 1/ prices.away : 0,
  };
  const sum = inv.home + inv.draw + inv.away || 1;
  return { home: inv.home/sum, draw: inv.draw/sum, away: inv.away/sum };
}
function mergeBookmakers(baseBooks=[], addBooks=[]){
  const byKey = new Map((baseBooks||[]).map(b => [b.key || b.title, b]));
  for (const b of (addBooks||[])){
    const k = b.key || b.title;
    if (!k) continue;
    const exist = byKey.get(k);
    if (!exist) { byKey.set(k, b); continue; }
    const mMap = new Map((exist.markets||[]).map(m=>[m.key, m]));
    for (const m of (b.markets||[])) if (!mMap.has(m.key)) mMap.set(m.key, m);
    exist.markets = Array.from(mMap.values());
    byKey.set(k, exist);
  }
  return Array.from(byKey.values());
}

async function oaGetUsed(ymd, diag){
  const { raw } = await kvGET(`oa:used:${ymd}`, diag);
  if (!raw) return 0;
  const val = J(raw);
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (val && typeof val === "object" && Number.isFinite(val.used)) return Number(val.used);
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 0;
}
async function oaSetUsed(ymd, used, diag){
  await kvSET(`oa:used:${ymd}`, JSON.stringify(used), diag);
}

async function fetchOddsBulk(regions, markets, capLimit, diag){
  const calls = [];
  const map = new Map();
  let used = 0;

  for (const region of regions){
    for (const market of markets){
      if (!OA_KEY) break;
      if (used >= capLimit) { calls.push({ note:"cap-reached", used, cap:capLimit }); break; }

      const url = `${OA_BASE}/sports/soccer/odds/?apiKey=${encodeURIComponent(OA_KEY)}&regions=${encodeURIComponent(region)}&markets=${encodeURIComponent(market)}&dateFormat=iso&oddsFormat=decimal`;
      let arr = [];
      let status = 0, ok=false, count=0, remaining=null;
      try{
        const r = await fetch(url, { cache:"no-store" });
        status = r.status; ok = r.ok;
        remaining = parseInt(r.headers.get("x-requests-remaining")||"",10);
        const t = await r.text();
        arr = JSON.parse(t);
        count = Array.isArray(arr) ? arr.length : 0;
      }catch(e){
        calls.push({ host:OA_BASE, path:"/sports/soccer/odds", region, market, status, ok:false, err:String(e?.message||e) });
        used++; // brojimo pokušaj
        continue;
      }

      calls.push({ host:OA_BASE, path:"/sports/soccer/odds", region, market, status, ok, count, remaining });
      used++;

      if (Array.isArray(arr)){
        for (const ev of arr){
          const key = ev?.id || `${ev?.home_team||""}__${ev?.away_team||""}__${ev?.commence_time||""}`;
          if (!key) continue;
          const cur = map.get(key);
          if (!cur){
            map.set(key, { ...ev, bookmakers: Array.isArray(ev.bookmakers)?ev.bookmakers:[] });
          }else{
            cur.bookmakers = mergeBookmakers(cur.bookmakers, ev.bookmakers||[]);
            map.set(key, cur);
          }
        }
      }
      if (Number.isFinite(remaining) && remaining <= 2){ calls.push({ note:"low-remaining", remaining }); break; }
    }
  }
  diag && (diag.odds_api_calls = calls);
  return { events: Array.from(map.values()), used };
}

async function fetchFixtureMeta(ids, diag){
  const out = {};
  for (const id of ids){
    try{
      const j = await afFetch("/fixtures",{ id }, afFixturesHeaders(), "fixture:byid", diag);
      const fx = Array.isArray(j?.response) ? j.response[0] : null;
      if (fx){ out[id] = mapFixture(fx); }
    }catch(e){ /* ignore */ }
  }
  return out;
}
function matchEventForFixture(meta, events){
  if (!meta) return null;
  const ks = new Date(meta.kickoff_utc).getTime();
  const sH = slugTeam(meta.home);
  const sA = slugTeam(meta.away);
  let best = null; let bestDelta = Infinity;
  for (const ev of events){
    const eh = slugTeam(ev?.home_team);
    const ea = slugTeam(ev?.away_team);
    if (!eh || !ea) continue;
    const teamMatch = (eh===sH && ea===sA) || (eh===sA && ea===sH);
    if (!teamMatch) continue;
    const ct = Date.parse(ev?.commence_time || 0) || 0;
    const delta = Math.abs(ct - ks);
    if (delta <= 1000*60*60*12 && delta < bestDelta){ best = ev; bestDelta = delta; }
  }
  return best;
}
function aggregateH2H(event){
  const books = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const sH = slugTeam(event?.home_team);
  const sA = slugTeam(event?.away_team);

  let homePrices = [], drawPrices = [], awayPrices = [];
  let usedBooks = 0;

  for (const b of books){
    const markets = Array.isArray(b?.markets) ? b.markets : [];
    const h2h = markets.find(m => (m?.key||"").toLowerCase() === "h2h");
    if (!h2h || !Array.isArray(h2h.outcomes)) continue;

    let found = { h:null, d:null, a:null };
    for (const o of h2h.outcomes){
      const name = slugTeam(o?.name);
      const price = Number(o?.price);
      if (!Number.isFinite(price)) continue;
      if (name === sH) found.h = price;
      else if (name === sA) found.a = price;
      else if (name === "draw") found.d = price;
    }
    if (found.h && found.a && (found.d || found.d === 0)){
      homePrices.push(found.h);
      drawPrices.push(found.d);
      awayPrices.push(found.a);
      usedBooks++;
    }
  }

  const med = { home: median(homePrices), draw: median(drawPrices), away: median(awayPrices) };
  const nv  = noVigImplied(med);
  const books_count = usedBooks;

  return {
    hda: {
      home: { price: med.home, pi_novig: nv.home },
      draw: { price: med.draw, pi_novig: nv.draw },
      away: { price: med.away, pi_novig: nv.away },
    },
    books_count,
    by_source: { af: 0, odds_api: books_count },
    regions: OA_REGIONS,
    markets: OA_MARKETS,
    updated_at: new Date().toISOString(),
  };
}

async function refreshOddsWithOddsAPI(ids, diag, capLimit){
  if (!OA_KEY || capLimit <= 0) return { matched:0, saved:0, calls:0 };
  const { events, used } = await fetchOddsBulk(OA_REGIONS.length?OA_REGIONS:["eu"], OA_MARKETS.length?OA_MARKETS:["h2h"], capLimit, diag);
  if (!events.length) return { matched:0, saved:0, calls: used };

  const metaMap = await fetchFixtureMeta(ids, diag);
  let matched = 0, saved = 0;

  for (const id of ids){
    const meta = metaMap[id];
    const ev = matchEventForFixture(meta, events);
    if (!ev) continue;
    matched++;

    const agg = aggregateH2H(ev);
    await kvSET(`odds:agg:${id}`, JSON.stringify(agg), diag);
    saved++;
  }
  return { matched, saved, calls: used };
}

/* ---------- handler ---------- */
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const wantDebug = String(q.debug ?? "") === "1";
  const diag = wantDebug ? {} : null;

  try{
    const now = new Date();
    const ymd  = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));

    const tried = [];
    let pickedKey = null;
    let list = [];
    let seeded = false;

    async function takeFromKey(key, picker){
      tried.push(key);
      const { raw } = await kvGET(key, diag);
      const arr = arrFromAny(unpack(raw));
      if (!Array.isArray(arr) || arr.length===0) return false;
      const ids = (picker ? arr.map(picker) : arr).map(x=>Number(x)).filter(Boolean);
      if (!ids.length) return false;
      if (list.length===0){ list = Array.from(new Set(ids)); pickedKey = key; }
      return true;
    }

    await takeFromKey(`vb:day:${ymd}:${slot}`, x=>x?.fixture_id);
    if (list.length===0) await takeFromKey(`vb:day:${ymd}:union`, x=>x?.fixture_id);
    if (list.length===0) await takeFromKey(`vb:day:${ymd}:last`,  x=>x?.fixture_id);
    if (list.length===0) await takeFromKey(`vbl_full:${ymd}:${slot}`);
    if (list.length===0) await takeFromKey(`fixtures:multi`);

    if (list.length===0){
      const strict = await fetchFixturesIDsByDateStrict(ymd, slot, diag);
      if (strict.length) list = strict;
      else {
        const whole = await fetchFixturesIDsWholeDay(ymd, slot, diag);
        if (whole.length) list = whole;
      }
      if (list.length){
        await kvSET(`fixtures:${ymd}:${slot}`, JSON.stringify(list), diag);
        await kvSET(`fixtures:multi`, JSON.stringify(list), diag);
        seeded = true;
      }
    }

    if (list.length===0){
      return res.status(200).json({
        ok:true, ymd, slot,
        inspected:0, filtered:0, targeted:0, touched:0,
        source:"refresh-odds:no-slot-matches",
        debug: wantDebug ? { tried, pickedKey, listLen:0, forceSeed:seeded, af: diag?.af } : undefined
      });
    }

    const ids = Array.from(new Set(list));

    // --- Compute remaining daily OA budget (hard cap) ---
    const usedStart = await oaGetUsed(ymd, diag);
    const remaining = Math.max(0, OA_BUDGET_PER_DAY - usedStart);
    const perRunCap = Math.max(0, Math.min(remaining, OA_DAILY_CAP));

    // --- ODDS_API enrichment on shortlist (bulk, regions×markets; safe & capped) ---
    let oa = { matched:0, saved:0, calls:0 };
    try{
      if (OA_KEY && perRunCap > 0) {
        const shortlist = ids.slice(0, 20); // držimo potrošnju niskom po slotu
        oa = await refreshOddsWithOddsAPI(shortlist, diag, perRunCap);
        // persist daily counter
        await oaSetUsed(ymd, usedStart + oa.calls, diag);
      }
    }catch(e){
      diag && (diag.odds_api = diag.odds_api || []).push({ err: String(e?.message||e) });
    }

    // Uvek osveži AF /odds kao i do sada (postojeće ponašanje)
    const touched = await refreshOddsForIDs(ids, diag);

    return res.status(200).json({
      ok:true, ymd, slot,
      inspected: ids.length, filtered:0, targeted: ids.length, touched,
      source: pickedKey ? `refresh-odds:${pickedKey}` : "refresh-odds:fallback",
      debug: wantDebug ? {
        tried, pickedKey, listLen: ids.length, forceSeed: seeded,
        af: diag?.af, odds: diag?.odds,
        odds_api_calls: diag?.odds_api_calls, // detalji per region/market
        oa_summary: { ...oa, budget_per_day: OA_BUDGET_PER_DAY, used_start: usedStart, remaining_before: remaining, used_now: usedStart + oa.calls }
      } : undefined
    });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
