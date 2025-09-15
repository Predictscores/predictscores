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
        body: body
      });
      trace && trace.push({ set:key, flavor:b.flavor, ok:r.ok });
      if (r.ok) return true;
    } catch(e) {
      trace && trace.push({ set:key, flavor:b.flavor, error:String(e?.message||e) });
    }
  }
  return false;
}

/* ---------- mali date helpers ---------- */
function pad(n){ return String(n).padStart(2,'0'); }
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

// slot prozori u lokalnom TZ; pretvaramo u UTC timestamps
function slotWindowUTC(ymd, slot, tz){
  const base = new Date(`${ymd}T00:00:00`);
  const addH = (h)=> new Date(new Date(base).setUTCHours(h)); // aproks — koristimo UTC jer fixtures su u UTC
  let fromH=0, toH=24;
  if (slot==="late") { fromH=0;  toH=10; }
  if (slot==="am")   { fromH=10; toH=15; }
  if (slot==="pm")   { fromH=15; toH=24; }
  return { from:addH(fromH), to:addH(toH) };
}

/* ---------- OA pulling ---------- */
// Default sada uključuje btts i ht_ft; ako plan vrati 400, automatski se pada na "h2h,totals" u fetchOA()
const OA_MARKETS = process.env.ODDS_API_MARKETS || "h2h,totals,btts,ht_ft";

function normalizeBookName(n){ return strip(n); }
function pullPriceOA(bookmakers, marketKey, pickPredicate, periodFilter=null) {
  const prices = [];
  for (const bm of (bookmakers||[])) {
    const bmName = normalizeBookName(bm?.title||bm?.key||"");
    if (!bm?.markets) continue;
    for (const mk of (bm.markets||[])) {
      if (String(mk?.key) !== String(marketKey)) continue;
      const mktOutcomes = (mk?.outcomes||[]).filter(o=> pickPredicate(o) );
      for (const o of mktOutcomes) {
        const price = Number(o?.price||o?.odds||o?.decimal||o?.points||o?.value);
        if (Number.isFinite(price)) prices.push(price);
      }
    }
  }
  if (!prices.length) return null;
  prices.sort((a,b)=>a-b);
  if (prices.length>4) prices.splice(0,1), prices.splice(-1,1);
  return prices.length? prices[Math.floor(prices.length/2)] : null;
}

async function fetchOAByFixture(fixture, trace){
  const apiKey = process.env.ODDS_API_KEY || process.env.THEODDS_API_KEY;
  if (!apiKey) return { called:false, ok:false, events:0, reason:"no-oa-key" };

  const sport = 'soccer';
  const regions = process.env.ODDS_API_REGIONS || 'eu,uk,us';
  const markets = OA_MARKETS; // npr. "h2h,totals,btts,ht_ft"

  const tryFetch = async (mk) => {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(mk)}&oddsFormat=decimal&dateFormat=iso&apiKey=${encodeURIComponent(apiKey)}`;
    try {
      const r = await fetch(url, { cache:'no-store' });
      const ok = r.ok;
      const status = r.status;
      const j = await r.json().catch(()=>({events:0}));
      trace && trace.push({ oa_fetch:{ ok, status, markets:mk, events: Array.isArray(j)? j.length : (j?.length||0) } });
      return { ok, status, events: Array.isArray(j)? j.length : (j?.length||0), payload: j };
    } catch(e){
      trace && trace.push({ oa_error:String(e?.message||e) });
      return { ok:false, status:0, events:0, payload:null };
    }
  };

  // 1) pokušaj sa onim što je zadato / ENV
  let res = await tryFetch(OA_MARKETS);
  // 2) fallback ako je invalid market (400)
  if (!res.ok && res.status === 400 && OA_MARKETS !== "h2h,totals") {
    res = await tryFetch("h2h,totals");
  }
  return { events: res.events, called:true, ok: res.ok };
}

/* ---------- AF odds pulling (primarno) ---------- */
async function fetchAFOddsByFixture(fixId, needFH=false, trace){
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return { ok:false, reason:"no-af-key" };

  const headers = { 'x-apisports-key': key };
  const url = (endpoint) => `https://v3.football.api-sports.io/${endpoint}`;

  const tasks = [];
  // OU/BTTS/1X2/HTFT/FH OU; 1st half totals su "goals/odds" uz filter periods
  tasks.push(fetch(url(`odds?fixture=${fixId}`), { headers, cache:'no-store' }).then(r=>r.json()).catch(()=>null));
  if (needFH) tasks.push(fetch(url(`odds?fixture=${fixId}&bet=5`), { headers, cache:'no-store' }).then(r=>r.json()).catch(()=>null)); // bet=5 je primer; ostavimo 1 poziv

  const [j1, j2] = await Promise.all(tasks);
  trace && trace.push({ af_responses:[ Boolean(j1?.response?.length), Boolean(j2?.response?.length) ] });
  return { ok:true, payload:[j1,j2] };
}

/* ---------- trusted / helpers ---------- */
const strip = s => String(s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[\W_]+/g,"").toLowerCase();
const TRUSTED = (() => {
  const env = String(process.env.TRUSTED_BOOKIES||"").split(",").map(s=>strip(s));
  const def = ["bet365","pinnacle","williamhill","marathonbet","unibet","888sport","skybet","betfair","betway","ladbrokes","coral","bwin","leon","parimatch","10bet"].map(strip);
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
function inRange(p, lo, hi){ return Number.isFinite(p) && p>=lo && p<=hi; }
function impliedSumOk(prices){
  const inv = (p)=> (Number.isFinite(p)&&p>0)?(1/p):0;
  const s = (prices||[]).map(inv).reduce((a,b)=>a+b,0);
  return s>0.9 && s<1.1;
}

/* ---------- merge helper ---------- */
function mergeMarkets(orig, add){
  const out = { ...(orig||{}) };
  for (const k of Object.keys(add||{})) out[k] = { ...(orig?.[k]||{}), ...(add?.[k]||{}) };
  return out;
}

/* ---------- glavni handler ---------- */
export default async function handler(req, res) {
  const t0 = Date.now();
  const trace = [];

  try {
    const slot = String(req.query.slot||"pm").toLowerCase();
    const now = new Date();

    const ymd = String(req.query.ymd||'').trim() || ymdInTZ(now, TZ);
    const window = slotWindowUTC(ymd, slot, TZ);

    // Učitamo poslednji union za dan+slot
    const unionKey = `vb:day:${ymd}:${slot}`;
    const union = await kvGETjson(unionKey, trace) || { items:[] };

    // Radi sigurnosti uzmemo i "vbl:ymd:slot" (pre-merge) ako treba
    const fullKey = `vbl_full:${ymd}:${slot}`;
    const full = await kvGETjson(fullKey, trace) || { items:[] };

    const items = (union?.items?.length ? union.items : full.items) || [];

    let afUpdated=0, oaUpdated=0, miss=0;

    // Prođi kroz svaki fixture i obogati markete
    for (const it of items) {
      const fixture_id = it?.fixture_id || it?.id || it?.fixtureId;
      if (!fixture_id) { miss++; continue; }

      const needFH = true; // hoćemo i FH OU1.5
      const af = await fetchAFOddsByFixture(fixture_id, needFH, trace);

      const markets = { ...(it?.markets||{}) };

      // --- AF parsiranje ---
      try {
        const payloads = af?.payload||[];
        for (const p of payloads) {
          for (const r of (p?.response||[])) {
            for (const bk of (r?.bookmakers||[])) {
              const bkName = strip(bk?.name||bk?.title||bk?.key||"");
              const allow = process.env.ODDS_TRUSTED_ONLY==='1' ? TRUSTED.has(bkName) : (TRUSTED.has(bkName) || true);
              if (!allow) continue;

              for (const bet of (bk?.bets||[])) {
                const label = String(bet?.name||"").toLowerCase();

                // 1X2
                if (/match winner|1x2/.test(label)) {
                  const h = Number(bet?.values?.find(v=>/home|1/i.test(v?.value))?.odd);
                  const a = Number(bet?.values?.find(v=>/away|2/i.test(v?.value))?.odd);
                  if ((Number.isFinite(h)||Number.isFinite(a)) && impliedSumOk([h,a]) && inRange(h??1.8,1.15,10) && inRange(a??1.8,1.15,10)) {
                    markets['1x2'] = { home:h??null, away:a??null };
                    afUpdated++;
                  }
                }

                // BTTS
                if (/both teams to score|btts/.test(label)) {
                  const yes = Number(bet?.values?.find(v=>/yes/i.test(v?.value))?.odd);
                  const no  = Number(bet?.values?.find(v=>/no/i.test(v?.value))?.odd);
                  if ([yes,no].some(Number.isFinite) && impliedSumOk([yes,no]) && inRange(yes??1.8,1.25,5.0)) {
                    markets['btts'] = { yes:yes??null, no:no??null };
                    afUpdated++;
                  }
                }

                // OU 2.5
                if (/totals|over\/under|goals/.test(label)) {
                  const over25 = Number(bet?.values?.find(v=>/(^|\s)over\s*2\.5/i.test(v?.value))?.odd);
                  const under25= Number(bet?.values?.find(v=>/(^|\s)under\s*2\.5/i.test(v?.value))?.odd);
                  if ((Number.isFinite(over25)||Number.isFinite(under25)) && impliedSumOk([over25,under25])) {
                    markets['ou25'] = { over:over25??null, under:under25??null };
                    afUpdated++;
                  }

                  // FH OU 1.5 (ako se nađe 1st half)
                  const isFH = /1st half|first half|fh/i.test(label);
                  if (isFH) {
                    const ouO = Number(bet?.values?.find(v=>/(^|\s)over\s*1\.5/i.test(v?.value))?.odd);
                    const ouU = Number(bet?.values?.find(v=>/(^|\s)under\s*1\.5/i.test(v?.value))?.odd);
                    if ((Number.isFinite(ouO)||Number.isFinite(ouU)) && impliedSumOk([ouO,ouU])) {
                      markets['fh_ou15'] = { over:ouO??null, under:ouU??null };
                      afUpdated++;
                    }
                  }
                }

                // HT/FT
                if (/half time\/full time|ht\/ft|htft/.test(label)) {
                  const hh = Number(bet?.values?.find(v=>/home\/?home/i.test(v?.value))?.odd);
                  const aa = Number(bet?.values?.find(v=>/away\/?away/i.test(v?.value))?.odd);
                  if ((Number.isFinite(hh)&&inRange(hh,3,40)) || (Number.isFinite(aa)&&inRange(aa,3,40))) {
                    markets['htft'] = { hh:hh??null, aa:aa??null };
                    afUpdated++;
                  }
                }
              }
            }
          }
        }
      } catch(e) { trace.push({ af_parse_error:String(e?.message||e) }); }

      // --- OA fallback ---
      try {
        const oaOk = await fetchOAByFixture(it, trace);
        if (oaOk?.ok) {
          const oa = oaOk?.payload || oaOk?.data; // nije vraćeno ovde ali ostavljeno kao ideja
          // Pošto The Odds API v4 vraća listu događaja, a mi ovde ne mapiramo po ID-u,
          // oslanjamo se na standardni parser u ovom projektu koji je već imao pullPriceOA
          // (ovde je samo izvod – ključno je da su marketKey vrednosti ispravne: "btts" i "ht_ft").
        }
      } catch(e) { trace.push({ oa_fallback_error:String(e?.message||e) }); }

      // OA konkretan pull iz već pripremljenog polja (ako ga ima na item-u)
      try {
        const books = it?.bookmakers || it?.oa_books || [];
        // OU 2.5
        const ouO = pullPriceOA(books, "totals", o=>/(^|\s)over\s*2\.5/i.test(String(o?.name||o?.description||"")));
        const ouU = pullPriceOA(books, "totals", o=>/(^|\s)under\s*2\.5/i.test(String(o?.name||o?.description||"")));
        if ((Number.isFinite(ouO)||Number.isFinite(ouU)) && impliedSumOk([ouO,ouU])) {
          markets.ou25 = { over:ouO??null, under:ouU??null };
          oaUpdated++;
        }
        // FH OU 1.5 (period filter preko naziva)
        const fhO = pullPriceOA(books, "totals", o=>/(^|\s)over\s*1\.5/i.test(String(o?.name||o?.description||"")) && /1st|first/i.test(String(o?.name||o?.description||"")));
        const fhU = pullPriceOA(books, "totals", o=>/(^|\s)under\s*1\.5/i.test(String(o?.name||o?.description||"")) && /1st|first/i.test(String(o?.name||o?.description||"")));
        if ((Number.isFinite(fhO)||Number.isFinite(fhU)) && impliedSumOk([fhO,fhU])) {
          markets.fh_ou15 = { over:fhO??null, under:fhU??null };
          oaUpdated++;
        }
        // BTTS (ispravan marketKey: btts)
        const bttsY = pullPriceOA(books, "btts", o=>/yes/i.test(String(o?.name)));
        const bttsN = pullPriceOA(books, "btts", o=>/no/i.test(String(o?.name)));
        if ([bttsY,bttsN].some(Number.isFinite) && impliedSumOk([bttsY,bttsN]) && inRange(bttsY??1.8,1.25,5.0)) {
          markets.btts = { yes:bttsY??null, no:bttsN??null };
          oaUpdated++;
        }
        // HT/FT (ispravan marketKey: ht_ft)
        const htftHH = pullPriceOA(books, "ht_ft", o=>/home\/home/i.test(String(o?.name)));
        const htftAA = pullPriceOA(books, "ht_ft", o=>/away\/away/i.test(String(o?.name)));
        if ((Number.isFinite(htftHH) && inRange(htftHH,3,40)) || (Number.isFinite(htftAA) && inRange(htftAA,3,40))) {
          markets.htft = { hh:htftHH??null, aa:htftAA??null };
          oaUpdated++;
        }
      } catch(e) { trace.push({ oa_parse_error:String(e?.message||e) }); }

      // upiši nazad u item
      it.markets = mergeMarkets(it.markets, markets);
    }

    // Sačuvaj full i union
    const outFull = { ...(full||{}), items };
    await kvSET(fullKey, outFull, trace);

    const unionOut = { ...(union||{}), items };
    await kvSET(unionKey, unionOut, trace);

    const ms = Date.now()-t0;
    return res.status(200).json({ ok:true, ymd, slot, af_updated:afUpdated, oa_updated:oaUpdated, miss, took_ms:ms, trace });
  } catch (e) {
    const ms = Date.now()-t0;
    return res.status(500).json({ ok:false, error:String(e?.message||e), took_ms:ms });
  }
}
