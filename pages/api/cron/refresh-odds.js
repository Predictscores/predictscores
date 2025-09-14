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
  : (x && typeof x==="object" && Array.isArray(x.list)) ? x.list : [];
const canonicalSlot = x=>{ x=String(x||"auto").toLowerCase(); return (x==="late"||x==="am"||x==="pm")?x:"auto"; };
const autoSlot = (d,tz)=>{ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); };

// FIX: am/pm/late -> uvek "danas" (oslanjamo se na eksplicitni ?ymd= kada ga workflow prosledi)
const targetYmdForSlot = (now,slot,tz)=> ymdInTZ(now, tz);

const isValidYmd = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||""));

/* ---------- trusted / helpers ---------- */
const strip = s => String(s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[\W_]+/g,"").toLowerCase();
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
function inRange(p, lo, hi){ return Number.isFinite(p) && p>=lo && p<=hi; }
function impliedSumOk(prices){
  const inv = (p)=> (Number.isFinite(p)&&p>0)?(1/p):0;
  const s = (prices||[]).map(inv).reduce((a,b)=>a+b,0);
  return s>=0.8 && s<=1.3;
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
  await kvSET(key, String(used+n), trace);
}

// FIX: prozor računamo iz IZABRANOG ymd (ne iz "now")
function slotWindowUTC(dayYmd, slot, tz) {
  const [Y,M,D] = String(dayYmd).split("-").map(Number);
  const base = new Date(Date.UTC(Y, M-1, D, 0, 0, 0));
  const addH = (h)=> new Date(base.getTime() + h*3600*1000);
  let fromH=0, toH=24;
  if (slot==="late") { fromH=0; toH=10; }
  if (slot==="am")   { fromH=10; toH=15; }
  if (slot==="pm")   { fromH=15; toH=24; }
  return { from:addH(fromH), to:addH(toH) };
}

/* ---------- OA pulling ---------- */
const OA_MARKETS = "h2h,totals,both_teams_to_score,half_time_full_time";
function normalizeBookName(n){ return strip(n); }
function pullPriceOA(bookmakers, marketKey, pickPredicate, periodFilter=null) {
  const prices = [];
  for (const bm of (bookmakers||[])) {
    const bn = normalizeBookName(bm?.title);
    if (!TRUSTED.has(bn)) continue;
    for (const mk of (bm?.markets||[])) {
      const key = String(mk?.key||"");
      if (key !== marketKey) continue;
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
function keyTeams(home,away){ return `${strip(home)}__${strip(away)}`; }
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
async function fetchOA(window, trace) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { events:[], called:false, ok:false };
  const regions = String(process.env.ODDS_API_REGION||"eu").trim() || "eu";
  const qs = new URLSearchParams({
    apiKey: key,
    regions: /\beu\b/i.test(regions) ? "eu,uk" : regions,
    markets: OA_MARKETS,
    oddsFormat: "decimal",
    dateFormat: "iso",
    commenceTimeFrom: window.from.toISOString(),
    commenceTimeTo: window.to.toISOString()
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

/* ---------- AF odds pulling (primarno) ---------- */
async function fetchAFOddsByFixture(fixtureId, trace){
  const key = process.env.API_FOOTBALL_KEY;
  if (!key || !fixtureId) return null;
  const url = `https://v3.football.api-sports.io/odds?fixture=${encodeURIComponent(String(fixtureId))}`;
  try {
    const r = await fetch(url, { headers:{ "x-apisports-key": key }, cache:"no-store" });
    const j = await r.json();
    trace && trace.push({ af_url:url, af_ok:r.ok, resp:Array.isArray(j?.response)? j.response.length : 0 });
    if (!r.ok || !Array.isArray(j?.response) || !j.response.length) return null;
    return j.response[0];
  } catch(e) {
    trace && trace.push({ af_err:String(e?.message||e) });
    return null;
  }
}
function pickFromAF(afResp){
  const out = {};
  const bms = afResp?.bookmakers || [];
  const collect = {
    h2h:   { home:[], draw:[], away:[] },
    btts:  { yes:[],  no:[] },
    ou25:  { over:[], under:[] },
    htft:  { hh:[],   aa:[] },
    fh_ou15: { over:[] }
  };
  for (const bm of bms) {
    const bn = strip(bm?.name);
    if (!TRUSTED.has(bn)) continue;
    for (const bet of (bm?.bets||[])) {
      const name = String(bet?.name||"").toLowerCase();
      for (const v of (bet?.values||[])) {
        const valTxt = String(v?.value||"").toLowerCase();
        const odd = Number(v?.odd);
        if (!Number.isFinite(odd)) continue;

        if (/1x2|match\s*winn?er/.test(name)) {
          if (/home/.test(valTxt)) collect.h2h.home.push(odd);
          else if (/draw|tie/.test(valTxt)) collect.h2h.draw.push(odd);
          else if (/away/.test(valTxt)) collect.h2h.away.push(odd);
        }
        if (/both\s*teams\s*to\s*score/.test(name)) {
          if (/yes/.test(valTxt)) collect.btts.yes.push(odd);
          if (/no/.test(valTxt))  collect.btts.no.push(odd);
        }
        if (/over\/under|goals\s*over\/under/.test(name) && !/1st|first\s*half/.test(name)) {
          if (/over\s*2\.?5/.test(valTxt))  collect.ou25.over.push(odd);
          if (/under\s*2\.?5/.test(valTxt)) collect.ou25.under.push(odd);
        }
        if (/ht\/ft|half\s*time\s*\/\s*full\s*time/.test(name)) {
          if (/home\/home/.test(valTxt)) collect.htft.hh.push(odd);
          if (/away\/away/.test(valTxt)) collect.htft.aa.push(odd);
        }
        if ((/over\/under|goals\s*over\/under/.test(name) && /1st|first\s*half/.test(name)) ||
            (/first\s*half.*over\/under/.test(name))) {
          if (/over\s*1\.?5/.test(valTxt)) collect.fh_ou15.over.push(odd);
        }
      }
    }
  }
  const med = (arr)=> trimMedian(arr);

  const H = med(collect.h2h.home), D = med(collect.h2h.draw), A = med(collect.h2h.away);
  if ([H,D,A].some(Number.isFinite) && impliedSumOk([H,D,A]) && inRange(H??1.5,1.15,20) && inRange(A??1.5,1.15,20))
    out.h2h = { home:H??null, draw:D??null, away:A??null };

  const Y = med(collect.btts.yes), N = med(collect.btts.no);
  if ([Y,N].some(Number.isFinite) && impliedSumOk([Y,N]) && inRange(Y??1.8,1.25,5.0))
    out.btts = { yes:Y??null, no:N??null };

  const O = med(collect.ou25.over), U = med(collect.ou25.under);
  if ([O,U].some(Number.isFinite) && impliedSumOk([O,U]) && inRange(O??1.6,1.2,5.5) && inRange(U??2.2,1.2,5.5))
    out.ou25 = { over:O??null, under:U??null };

  const HH = med(collect.htft.hh), AA = med(collect.htft.aa);
  if ([HH,AA].some(Number.isFinite) && (inRange(HH??3,3,40) || inRange(AA??3,3,40)))
    out.htft = { hh:HH??null, aa:AA??null };

  const FH = med(collect.fh_ou15.over);
  if (Number.isFinite(FH) && inRange(FH,1.2,5.0))
    out.fh_ou15 = { over: FH };

  return out;
}

/* ---------- confidence / kickoff helpers ---------- */
function confPct(it){ return Number.isFinite(it?.confidence_pct) ? it.confidence_pct : (Number(it?.confidence)||0); }
function kickoffISO(it){ return it?.kickoff_utc || it?.fixture?.date || it?.kickoff || it?.fixture_date || it?.ts || null; }
function kickoffTime(it){ const d = kickoffISO(it) ? new Date(kickoffISO(it)).getTime() : 0; return Number.isFinite(d) ? d : 0; }

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;

    // NEW: ymd override iz query-ja (prioritet)
    const qYmd = String(req.query.ymd||"").trim();
    const ymd  = isValidYmd(qYmd) ? qYmd : targetYmdForSlot(now, slot, TZ);

    // ---- skupi izvore ----
    const srcKeys = [
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vbl_full:${ymd}:${slot}`
    ];
    const seen = new Map();
    let firstSrc=null;
    for (const k of srcKeys) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (!arr.length) continue;
      if (!firstSrc) firstSrc = k;
      for (const it of arr) {
        const fix = it?.fixture_id || it?.fixture?.id || it?.id;
        const key = String(fix||"");
        if (!key) continue;
        if (!seen.has(key)) seen.set(key, it);
      }
    }
    const items = Array.from(seen.values());
    if (!items.length) {
      return res.status(200).json({ ok:true, ymd, slot, msg:"no source", updated:0 });
    }

    const hasFH = items.filter(it => Number.isFinite(it?.markets?.fh_ou15?.over)).length;

    const needersAll = items.filter(it => {
      const m = it?.markets||{};
      return (!Number.isFinite(m?.btts?.yes)) ||
             (!Number.isFinite(m?.ou25?.over)) ||
             (!Number.isFinite(m?.h2h?.home))  ||
             (!Number.isFinite(m?.htft?.hh) && !Number.isFinite(m?.htft?.aa)) ||
             (!Number.isFinite(m?.fh_ou15?.over));
    });

    needersAll.sort((a,b)=>{
      const dc = (confPct(b) - confPct(a));
      if (dc) return dc;
      const ma = a?.markets, mb = b?.markets;
      const ha = !!(ma && (ma.h2h||ma.ou25||ma.btts||ma.htft||ma.fh_ou15));
      const hb = !!(mb && (mb.h2h||mb.ou25||mb.btts||mb.htft||mb.fh_ou15));
      if (ha !== hb) return hb ? 1 : -1;
      const dk = kickoffTime(a) - kickoffTime(b);
      if (dk) return dk;
      return 0;
    });

    const PASS1_LIMIT = 60;
    let afUpdated=0;
    for (const it of needersAll.slice(0, PASS1_LIMIT)) {
      const fix = it?.fixture_id || it?.fixture?.id;
      const af = await fetchAFOddsByFixture(fix, trace);
      if (!af) continue;
      const parsed = pickFromAF(af);
      if (parsed && Object.keys(parsed).length) {
        it.markets = { ...(it.markets||{}), ...parsed };
        afUpdated++;
      }
    }

    const hasFHafter1 = items.filter(it => Number.isFinite(it?.markets?.fh_ou15?.over)).length;

    let afUpdatedFH=0;
    if (hasFHafter1 < 4) {
      const fhNeeders = items
        .filter(it => !Number.isFinite(it?.markets?.fh_ou15?.over))
        .sort((a,b)=> {
          const dc = (confPct(b) - confPct(a)); if (dc) return dc;
          return kickoffTime(a) - kickoffTime(b);
        });
      const PASS2_LIMIT = 80;
      for (const it of fhNeeders.slice(0, PASS2_LIMIT)) {
        const fix = it?.fixture_id || it?.fixture?.id;
        const af = await fetchAFOddsByFixture(fix, trace);
        if (!af) continue;
        const parsed = pickFromAF(af);
        if (parsed?.fh_ou15) {
          it.markets = { ...(it.markets||{}), fh_ou15: parsed.fh_ou15, h2h: parsed.h2h || it.markets?.h2h, btts: parsed.btts || it.markets?.btts, ou25: parsed.ou25 || it.markets?.ou25, htft: parsed.htft || it.markets?.htft };
          afUpdatedFH++;
        }
        if ((items.filter(x=>Number.isFinite(x?.markets?.fh_ou15?.over)).length) >= 4) break;
      }
    }

    // OA fallback iz prozora za upravo taj ymd+slot
    const { remaining } = await oaRemaining(ymd, trace);
    const maxTargets = Math.min(5, remaining);
    let oaUsed=0, oaUpdated=0;
    if (maxTargets>0) {
      const window = slotWindowUTC(ymd, slot, TZ);
      const oa = await fetchOA(window, trace);
      const byTeams = mapOAbyTeams(oa.events||[]);

      const stillNeed = items.filter(it => {
        const m = it?.markets||{};
        return (!Number.isFinite(m?.btts?.yes)) ||
               (!Number.isFinite(m?.ou25?.over)) ||
               (!Number.isFinite(m?.h2h?.home))  ||
               (!Number.isFinite(m?.htft?.hh) && !Number.isFinite(m?.htft?.aa)) ||
               (!Number.isFinite(m?.fh_ou15?.over));
      }).sort((a,b)=>{
        const dk = kickoffTime(a) - kickoffTime(b);
        if (dk) return dk;
        return (confPct(b) - confPct(a));
      }).slice(0, maxTargets);

      for (const it of stillNeed) {
        const home = it?.teams?.home?.name || it?.home?.name;
        const away = it?.teams?.away?.name || it?.away?.name;
        if (!home || !away) continue;
        const k = keyTeams(home, away);
        const cands = byTeams.get(k) || byTeams.get(keyTeams(away, home)) || [];
        if (!cands.length) continue;
        const match = closestByTime(cands, kickoffISO(it));
        if (!match) continue;

        const books = match?.bookmakers || [];
        const markets = it.markets || (it.markets = {});

        const h   = pullPriceOA(books, "h2h", o=>String(o?.name).toLowerCase()==="home");
        const d   = pullPriceOA(books, "h2h", o=>String(o?.name).toLowerCase()==="draw");
        const a   = pullPriceOA(books, "h2h", o=>String(o?.name).toLowerCase()==="away");
        if ([h,d,a].some(Number.isFinite) && impliedSumOk([h,d,a]) && inRange(h??1.5,1.15,20) && inRange(a??1.5,1.15,20)) {
          markets.h2h = { home:h??null, draw:d??null, away:a??null };
          oaUpdated++;
        }

        const ouO = pullPriceOA(books, "totals", o=> (Number(o?.point)===2.5) && String(o?.name).toLowerCase()==="over", desc=>/1st|first\s*half/i.test(desc)===false);
        const ouU = pullPriceOA(books, "totals", o=> (Number(o?.point)===2.5) && String(o?.name).toLowerCase()==="under", desc=>/1st|first\s*half/i.test(desc)===false);
        if ([ouO,ouU].some(Number.isFinite) && impliedSumOk([ouO,ouU]) && inRange(ouO??1.6,1.2,5.5) && inRange(ouU??2.2,1.2,5.5)) {
          markets.ou25 = { over:ouO??null, under:ouU??null };
          oaUpdated++;
        }

        const bttsY = pullPriceOA(books, "both_teams_to_score", o=>/yes/i.test(String(o?.name)));
        const bttsN = pullPriceOA(books, "both_teams_to_score", o=>/no/i.test(String(o?.name)));
        if ([bttsY,bttsN].some(Number.isFinite) && impliedSumOk([bttsY,bttsN]) && inRange(bttsY??1.8,1.25,5.0)) {
          markets.btts = { yes:bttsY??null, no:bttsN??null };
          oaUpdated++;
        }

        const htftHH = pullPriceOA(books, "half_time_full_time", o=>/home\/home/i.test(String(o?.name)));
        const htftAA = pullPriceOA(books, "half_time_full_time", o=>/away\/away/i.test(String(o?.name)));
        if ((Number.isFinite(htftHH) && inRange(htftHH,3,40)) || (Number.isFinite(htftAA) && inRange(htftAA,3,40))) {
          markets.htft = { hh:htftHH??null, aa:htftAA??null };
          oaUpdated++;
        }

        const fhO = pullPriceOA(books, "totals", o=> (Number(o?.point)===1.5) && String(o?.name).toLowerCase()==="over", desc=>/1st|first\s*half/i.test(desc));
        if (Number.isFinite(fhO) && inRange(fhO,1.2,5.0)) {
          markets.fh_ou15 = { over: fhO };
          oaUpdated++;
        }

        oaUsed++;
        if (oaUsed>=maxTargets) break;
      }
      if (oaUsed>0) await oaConsume(ymd, oaUsed, trace);
    }

    if (afUpdated>0 || afUpdatedFH>0 || oaUsed>0) {
      await kvSET(`vbl_full:${ymd}:${slot}`, { items }, trace);
      const { raw:rawUnion } = await kvGETraw(`vb:day:${ymd}:union`, trace);
      const unionArr = arrFromAny(J(rawUnion));
      if (unionArr.length) {
        const byFix = new Map();
        for (const it of items) if (it?.fixture_id || it?.fixture?.id) byFix.set(String(it.fixture_id||it?.fixture?.id), it);
        let touched_union=0;
        for (const u of unionArr) {
          const fix = u?.fixture_id && byFix.get(String(u.fixture_id));
          if (fix?.markets) { u.markets = { ...u.markets, ...fix.markets }; touched_union++; }
        }
        if (touched_union>0) await kvSET(`vb:day:${ymd}:union`, { items: unionArr }, trace);
      }
    }

    return res.status(200).json({
      ok:true, ymd, slot, source:firstSrc,
      af_updated: afUpdated, af_updated_fh: afUpdatedFH,
      oa_used: oaUsed,
      debug:{ trace, fh_count_before: hasFH, fh_count_after: items.filter(it => Number.isFinite(it?.markets?.fh_ou15?.over)).length }
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
