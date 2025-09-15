// pages/api/cron/refresh-odds.js — SINGLE-CALL OA (15 req/day safe), proper btts/ht_ft, FH1.5+, and ymd guard
export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo TZ_DISPLAY) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV helpers (Vercel KV + opcioni Upstash fallback) ---------- */
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
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (raw!=null) return raw;
    } catch (e) {
      trace && trace.push({ get:key, flavor:b.flavor, error:String(e?.message||e) });
    }
  }
  return null;
}
async function kvGETjson(key, trace){
  const raw = await kvGETraw(key, trace);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function kvSET(key, value, trace){
  const body = typeof value === "string" ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method:"POST",
        headers:{ Authorization:`Bearer ${b.tok}`, "content-type":"application/json" },
        body
      });
      trace && trace.push({ set:key, flavor:b.flavor, ok:r.ok });
      if (r.ok) return true;
    } catch(e) {
      trace && trace.push({ set:key, flavor:b.flavor, error:String(e?.message||e) });
    }
  }
  return false;
}

/* ---------- Date helpers ---------- */
function ymdInTZ(d, tz){
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const [y,m,da] = f.formatToParts(d).reduce((o,p)=>{ if(p.type==='year')o[0]=p.value; if(p.type==='month')o[1]=p.value; if(p.type==='day')o[2]=p.value; return o; }, ["","",""]);
  return `${y}-${m}-${da}`;
}
function ymdhmsInTZ(d, tz){
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12:false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const parts = Object.fromEntries(f.formatToParts(d).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function slotWindowUTC(ymd, slot){
  // Radi jednostavnosti uzimamo UTC granice istog datuma
  const base = new Date(`${ymd}T00:00:00Z`);
  const from = new Date(base);
  const to   = new Date(base);
  if (slot==="late") { from.setUTCHours(0);  to.setUTCHours(10); }
  else if (slot==="am") { from.setUTCHours(10); to.setUTCHours(15); }
  else { from.setUTCHours(15); to.setUTCHours(24); }
  return { from, to };
}

/* ---------- Normalizacija i helpers ---------- */
const strip = s => String(s||"")
  .normalize("NFD").replace(/\p{Diacritic}/gu,"")
  .replace(/[\u2019'`]/g,"")
  .replace(/[^a-z0-9]+/gi," ")
  .trim().toLowerCase();

function normTeamName(name){
  let n = strip(name)
    .replace(/\b(fc|cf|sc|ac|fk|bk|sk|afc|bfk)\b/g, " ")
    .replace(/\b(women|ladies)\b/g, " ")
    .replace(/\b(u\d{2})\b/g, " ")
    .replace(/\b(ii|iii|iv)\b/g, " ")
    .replace(/\b(\d)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n;
}

function hoursDiff(a, b){ return Math.abs(new Date(a).getTime() - new Date(b).getTime())/36e5; }

/* ---------- Trusted set ---------- */
const TRUSTED = (() => {
  const env = String(process.env.TRUSTED_BOOKIES||"").split(",").map(s=>strip(s));
  const def = ["bet365","pinnacle","williamhill","marathonbet","unibet","888sport","skybet","betfair","betway","ladbrokes","coral","bwin","leon","parimatch","10bet","1xbet","betano","stake","tipsport","efbet","parionsport","toto"].map(strip);
  return new Set((env.length?env:def).filter(Boolean));
})();

const median = arr => {
  const a = ((arr)||[]).filter(n=>Number.isFinite(n)).sort((x,y)=>x-y);
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
function impliedSumOk(prices){
  const inv = (p)=> (Number.isFinite(p)&&p>0)?(1/p):0;
  const s = (prices||[]).map(inv).reduce((a,b)=>a+b,0);
  return s>0.9 && s<1.1;
}
function inRange(p, lo, hi){ return Number.isFinite(p) && p>=lo && p<=hi; }

/* ---------- API-Football (primarni) ---------- */
async function fetchAFOddsByFixture(fixId, needFH=false, trace){
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return { ok:false, reason:"no-af-key" };
  const headers = { 'x-apisports-key': key };
  const url = ep => `https://v3.football.api-sports.io/${ep}`;
  const tasks = [ fetch(url(`odds?fixture=${fixId}`), { headers, cache:'no-store' }).then(r=>r.json()).catch(()=>null) ];
  if (needFH) tasks.push(fetch(url(`odds?fixture=${fixId}&bet=5`), { headers, cache:'no-store' }).then(r=>r.json()).catch(()=>null));
  const [j1,j2] = await Promise.all(tasks);
  trace && trace.push({ af_responses:[ Boolean(j1?.response?.length), Boolean(j2?.response?.length) ] });
  return { ok:true, payload:[j1,j2] };
}

/* ---------- The Odds API (backup) — SINGLE CALL PER RUN ---------- */
const OA_MARKETS = process.env.ODDS_API_MARKETS || "h2h,totals,btts,ht_ft"; // v4 keys

async function fetchOAEvents(trace){
  const apiKey = process.env.ODDS_API_KEY || process.env.THEODDS_API_KEY;
  if (!apiKey) return { called:false, ok:false, events:[] };
  const sport = 'soccer';
  const regions = process.env.ODDS_API_REGIONS || 'eu,uk,us';

  const doFetch = async (mk) => {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(mk)}&oddsFormat=decimal&dateFormat=iso&apiKey=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url, { cache:'no-store' });
    const ct = r.headers.get('content-type')||'';
    const ok = r.ok && ct.includes('application/json');
    const data = ok ? await r.json() : [];
    trace && trace.push({ oa_fetch:{ ok:r.ok, status:r.status, markets:mk, ct, events: Array.isArray(data)? data.length : 0 } });
    return { ok:r.ok, status:r.status, data: Array.isArray(data)? data : [] };
  };

  let res = await doFetch(OA_MARKETS);
  if (!res.ok && res.status===400 && OA_MARKETS!=="h2h,totals") {
    // fallback ako je INVALID_MARKET
    res = await doFetch("h2h,totals");
  }
  return { called:true, ok:res.ok, events:res.data };
}

function filterTrustedOA(bookmakers){
  return (bookmakers||[]).filter(bm => TRUSTED.has(strip(bm?.title||bm?.key||bm?.name||"")));
}

function pullPriceOA(bookmakers, marketKey, outcomePred){
  const prices = [];
  for (const bm of filterTrustedOA(bookmakers)){
    for (const mk of (bm?.markets||[])){
      if (String(mk?.key)!==String(marketKey)) continue;
      for (const o of (mk?.outcomes||[])){
        if (!outcomePred(o, mk)) continue;
        const price = Number(o?.price ?? o?.odds ?? o?.decimal ?? o?.value);
        if (Number.isFinite(price)) prices.push(price);
      }
    }
  }
  if (!prices.length) return null;
  if (prices.length>4){ prices.sort((a,b)=>a-b); prices.shift(); prices.pop(); }
  return trimMedian(prices);
}

function isFirstHalf(o){
  const s = `${o?.name||''} ${o?.description||''}`;
  return /1st|first/i.test(s);
}

function matchOAEvent(oaEvents, home, away, kickoffISO){
  const H = normTeamName(home), A = normTeamName(away);
  let best=null, bestScore=1e9;
  for (const ev of (oaEvents||[])){
    const eh = normTeamName(ev?.home_team || ev?.homeTeam || ev?.teams?.home);
    const ea = normTeamName(ev?.away_team || ev?.awayTeam || ev?.teams?.away);
    if (!eh || !ea) continue;
    // jednostavna fuzzy usklađenost
    const homeOk = eh.includes(H) || H.includes(eh);
    const awayOk = ea.includes(A) || A.includes(ea);
    if (!homeOk || !awayOk) continue;
    const diff = hoursDiff(kickoffISO, ev?.commence_time);
    if (diff <= 6 && diff < bestScore){ bestScore=diff; best=ev; }
  }
  return best; // može biti null
}

function enrichFromOA(event, markets){
  const books = event?.bookmakers || [];
  // OU 2.5
  const ouO = pullPriceOA(books, 'totals', (o)=>/(^|\b)over\s*2\.?5\b/i.test(String(o?.name||'')));
  const ouU = pullPriceOA(books, 'totals', (o)=>/(^|\b)under\s*2\.?5\b/i.test(String(o?.name||'')));
  if ((Number.isFinite(ouO)||Number.isFinite(ouU)) && impliedSumOk([ouO,ouU])) markets.ou25 = { over:ouO??null, under:ouU??null };

  // FH OU 1.5 (mora sadržati 1st/First Half)
  const fhO = pullPriceOA(books, 'totals', (o)=>isFirstHalf(o) && /(\bover\s*1\.?5\b)/i.test(String(o?.name||'')));
  const fhU = pullPriceOA(books, 'totals', (o)=>isFirstHalf(o) && /(\bunder\s*1\.?5\b)/i.test(String(o?.name||'')));
  if ((Number.isFinite(fhO)||Number.isFinite(fhU)) && impliedSumOk([fhO,fhU])) markets.fh_ou15 = { over:fhO??null, under:fhU??null };

  // BTTS
  const bttsY = pullPriceOA(books, 'btts', (o)=>/yes/i.test(String(o?.name||'')));
  const bttsN = pullPriceOA(books, 'btts', (o)=>/no/i.test(String(o?.name||'')));
  if ([bttsY,bttsN].some(Number.isFinite) && impliedSumOk([bttsY,bttsN])) markets.btts = { yes:bttsY??null, no:bttsN??null };

  // HT/FT (samo HH i AA za sada)
  const htftHH = pullPriceOA(books, 'ht_ft', (o)=>/home\/?home/i.test(String(o?.name||'')));
  const htftAA = pullPriceOA(books, 'ht_ft', (o)=>/away\/?away/i.test(String(o?.name||'')));
  if ((Number.isFinite(htftHH) && inRange(htftHH,3,40)) || (Number.isFinite(htftAA) && inRange(htftAA,3,40))) {
    markets.htft = { hh:htftHH??null, aa:htftAA??null };
  }
}

function mergeMarkets(orig, add){
  const out = { ...(orig||{}) };
  for (const k of Object.keys(add||{})) out[k] = { ...(orig?.[k]||{}), ...(add?.[k]||{}) };
  return out;
}

/* ---------- Handler ---------- */
export default async function handler(req, res){
  const t0 = Date.now();
  const trace = [];
  try {
    const slot = String(req.query.slot||'pm').toLowerCase();
    const now = new Date();

    const rawYmd = String(req.query.ymd||'').trim();
    const ymd = /^\d{4}-\d{2}-\d{2}$/.test(rawYmd) ? rawYmd : ymdInTZ(now, TZ);
    if (rawYmd && !/^\d{4}-\d{2}-\d{2}$/.test(rawYmd)) trace.push({ warn:'ymd_placeholder_ignored', given:rawYmd, used:ymd });

    const window = slotWindowUTC(ymd, slot);

    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;

    const union = await kvGETjson(unionKey, trace) || { items:[] };
    const full  = await kvGETjson(fullKey,  trace) || { items:[] };

    const items = (union?.items?.length ? union.items : full.items) || [];

    // Jedan OA poziv za ceo run (štedi limit 15/dan)
    const oa = await fetchOAEvents(trace);

    let afUpdated=0, oaUpdated=0, miss=0;

    for (const it of items){
      const fixture_id = it?.fixture_id || it?.id || it?.fixtureId;
      const home = it?.home || it?.teams?.home || it?.team_home || it?.home_name;
      const away = it?.away || it?.teams?.away || it?.team_away || it?.away_name;
      const kickoffISO = it?.kickoff_utc || it?.kickoff || it?.datetime_utc || it?.date || null;
      if (!fixture_id || !home || !away || !kickoffISO){ miss++; continue; }

      const needFH = true;
      const markets = { ...(it?.markets||{}) };

      // API-Football — primarni
      try {
        const af = await fetchAFOddsByFixture(fixture_id, needFH, trace);
        const payloads = af?.payload||[];
        for (const p of payloads){
          for (const r of (p?.response||[])){
            for (const bk of (r?.bookmakers||[])){
              const bmName = strip(bk?.name||bk?.title||bk?.key||"");
              const allow = process.env.ODDS_TRUSTED_ONLY==='1' ? TRUSTED.has(bmName) : true;
              if (!allow) continue;
              for (const bet of (bk?.bets||[])){
                const label = String(bet?.name||"").toLowerCase();
                // 1X2
                if (/match winner|1x2/.test(label)){
                  const h = Number(bet?.values?.find(v=>/home|1/i.test(v?.value))?.odd);
                  const a = Number(bet?.values?.find(v=>/away|2/i.test(v?.value))?.odd);
                  if ((Number.isFinite(h)||Number.isFinite(a)) && impliedSumOk([h,a]) && inRange(h??1.8,1.15,10) && inRange(a??1.8,1.15,10)){
                    markets['1x2'] = { home:h??null, away:a??null };
                    afUpdated++;
                  }
                }
                // BTTS
                if (/both teams to score|btts/.test(label)){
                  const yes = Number(bet?.values?.find(v=>/yes/i.test(v?.value))?.odd);
                  const no  = Number(bet?.values?.find(v=>/no/i.test(v?.value))?.odd);
                  if ([yes,no].some(Number.isFinite) && impliedSumOk([yes,no])){
                    markets['btts'] = { yes:yes??null, no:no??null };
                    afUpdated++;
                  }
                }
                // OU (uključujući FH ako je označeno)
                if (/totals|over\/under|goals/.test(label)){
                  const over25 = Number(bet?.values?.find(v=>/(^|\s)over\s*2\.5/i.test(v?.value))?.odd);
                  const under25= Number(bet?.values?.find(v=>/(^|\s)under\s*2\.5/i.test(v?.value))?.odd);
                  if ((Number.isFinite(over25)||Number.isFinite(under25)) && impliedSumOk([over25,under25])){
                    markets['ou25'] = { over:over25??null, under:under25??null };
                    afUpdated++;
                  }
                  const isFH = /1st half|first half|fh/i.test(label);
                  if (isFH){
                    const ouO = Number(bet?.values?.find(v=>/(^|\s)over\s*1\.5/i.test(v?.value))?.odd);
                    const ouU = Number(bet?.values?.find(v=>/(^|\s)under\s*1\.5/i.test(v?.value))?.odd);
                    if ((Number.isFinite(ouO)||Number.isFinite(ouU)) && impliedSumOk([ouO,ouU])){
                      markets['fh_ou15'] = { over:ouO??null, under:ouU??null };
                      afUpdated++;
                    }
                  }
                }
                // HT/FT
                if (/half time\/full time|ht\/ft|htft/.test(label)){
                  const hh = Number(bet?.values?.find(v=>/home\/?home/i.test(v?.value))?.odd);
                  const aa = Number(bet?.values?.find(v=>/away\/?away/i.test(v?.value))?.odd);
                  if ((Number.isFinite(hh)&&inRange(hh,3,40)) || (Number.isFinite(aa)&&inRange(aa,3,40))){
                    markets['htft'] = { hh:hh??null, aa:aa??null };
                    afUpdated++;
                  }
                }
              }
            }
          }
        }
      } catch(e){ trace.push({ af_parse_error:String(e?.message||e) }); }

      // The Odds API — fallback (bez dodatnih poziva; koristimo jedan payload)
      try {
        if (oa?.ok && Array.isArray(oa.events) && oa.events.length){
          const ev = matchOAEvent(oa.events, home, away, kickoffISO);
          if (ev){
            const before = JSON.stringify(markets);
            enrichFromOA(ev, markets);
            const after = JSON.stringify(markets);
            if (before!==after) oaUpdated++;
          }
        }
      } catch(e){ trace.push({ oa_match_error:String(e?.message||e) }); }

      it.markets = mergeMarkets(it.markets, markets);
    }

    // Sačuvaj nazad
    const outFull = { ...(full||{}), items };
    await kvSET(fullKey, outFull, trace);

    const unionOut = { ...(union||{}), items };
    await kvSET(unionKey, unionOut, trace);

    const took = Date.now()-t0;
    return res.status(200).json({ ok:true, ymd, slot, af_updated:afUpdated, oa_updated:oaUpdated, miss, took_ms:took, trace, note:(oa?.called?undefined:'oa-not-called') });
  } catch (e){
    const took = Date.now()-t0;
    return res.status(500).json({ ok:false, error:String(e?.message||e), took_ms:took });
  }
}
