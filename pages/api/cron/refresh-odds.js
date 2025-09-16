// pages/api/cron/refresh-odds.js — AF-ONLY + daily budget guard (≤ 6000 AF calls/day), lazy FH fetch, safe parsing
export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo za ymd prikaz) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV helpers ---------- */
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
async function kvGETjson(key, trace){ const raw = await kvGETraw(key, trace); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
async function kvSET(key, value, trace){
  const body = typeof value === "string" ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, { method:"POST", headers:{ Authorization:`Bearer ${b.tok}`, "content-type":"application/json" }, body });
      trace && trace.push({ set:key, flavor:b.flavor, ok:r.ok });
      if (r.ok) return true;
    } catch(e) { trace && trace.push({ set:key, flavor:b.flavor, error:String(e?.message||e) }); }
  }
  return false;
}

/* ---------- Date helpers ---------- */
function ymdInTZ(d, tz){
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  const [y,m,da] = f.formatToParts(d).reduce((o,p)=>{ if(p.type==='year')o[0]=p.value; if(p.type==='month')o[1]=p.value; if(p.type==='day')o[2]=p.value; return o; }, ["","",""]);
  return `${y}-${m}-${da}`;
}

/* ---------- String & sanity helpers ---------- */
const strip = s => String(s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").replace(/[\W_]+/g,"").toLowerCase();
const TRUSTED = (() => {
  const env = String(process.env.TRUSTED_BOOKIES||"").split(",").map(s=>strip(s));
  const def = [
    "bet365","pinnacle","williamhill","marathonbet","unibet","888sport","skybet","betfair","betway",
    "ladbrokes","coral","bwin","leon","parimatch","10bet","1xbet","betano","stake","tipsport","efbet","parionsport","toto"
  ].map(strip);
  return new Set((env.length?env:def).filter(Boolean));
})();
const median = arr => { const a=(arr||[]).filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length) return null; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
function trimMedian(values){ const a=(values||[]).filter(Number.isFinite).sort((x,y)=>x-y); if(a.length<=2) return median(a); const cut=Math.max(1,Math.floor(a.length*0.2)); return median(a.slice(cut,a.length-cut)); }
function inRange(p, lo, hi){ return Number.isFinite(p) && p>=lo && p<=hi; }
function impliedSumOk(prices){ const inv=p=> (Number.isFinite(p)&&p>0)?1/p:0; const s=(prices||[]).map(inv).reduce((a,b)=>a+b,0); return s>0.9 && s<1.1; }
function mergeMarkets(orig, add){ const out={...(orig||{})}; for(const k of Object.keys(add||{})) out[k]={...(orig?.[k]||{}), ...(add?.[k]||{})}; return out; }

/* ---------- API-Football (AF) ---------- */
const AF_DAILY_BUDGET = 6000;     // hard cap po danu
const AF_RUN_HARDCAP   = 1800;    // cap po jednom run-u (slot)
const AF_BUDGET_KEY = (ymd) => `af_calls:${ymd}`; // { total, am, pm, late }

async function readAfBudget(ymd, trace){
  const key = AF_BUDGET_KEY(ymd);
  const j = await kvGETjson(key, trace) || { total:0, am:0, pm:0, late:0 };
  return j;
}
async function incAfBudget(ymd, slot, delta, trace){
  const key = AF_BUDGET_KEY(ymd);
  const cur = await kvGETjson(key, trace) || { total:0, am:0, pm:0, late:0 };
  const next = { ...cur, total: Math.max(0,(cur.total||0) + delta) };
  next[slot] = Math.max(0,(cur[slot]||0) + delta);
  await kvSET(key, next, trace);
  return next;
}

async function fetchAF_main(fixId, trace){
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return { ok:false, reason:"no-af-key" };
  const headers = { 'x-apisports-key': key };
  const url = ep => `https://v3.football.api-sports.io/${ep}`;
  const r = await fetch(url(`odds?fixture=${fixId}`), { headers, cache:'no-store' });
  const j = await r.json().catch(()=>null);
  trace && trace.push({ af_main_ok: r.ok, af_main_status:r.status });
  return { ok:r.ok, payload:j };
}
async function fetchAF_fh(fixId, trace){
  const key = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return { ok:false, reason:"no-af-key" };
  const headers = { 'x-apisports-key': key };
  const url = ep => `https://v3.football.api-sports.io/${ep}`;
  const r = await fetch(url(`odds?fixture=${fixId}&bet=5`), { headers, cache:'no-store' });
  const j = await r.json().catch(()=>null);
  trace && trace.push({ af_fh_ok: r.ok, af_fh_status:r.status });
  return { ok:r.ok, payload:j };
}

/* ---------- Glavni handler ---------- */
export default async function handler(req, res){
  const t0 = Date.now();
  const trace = [];
  try{
    const slot = String(req.query.slot||'pm').toLowerCase();
    const today = ymdInTZ(new Date(), TZ);
    const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ymd||'')) ? String(req.query.ymd) : today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ymd||''))) trace.push({ warn:'ymd_placeholder_or_missing', used:ymd });

    // ----- budget state -----
    const bud = await readAfBudget(ymd, trace);
    const used_before_total = bud.total || 0;
    const used_before_slot  = bud[slot] || 0;
    const left_total = Math.max(0, AF_DAILY_BUDGET - used_before_total);
    const allow_this_run = Math.max(0, Math.min(left_total, AF_RUN_HARDCAP));
    let used_this_run = 0;

    // ----- items -----
    const unionKey = `vb:day:${ymd}:${slot}`;  const union = await kvGETjson(unionKey, trace) || { items:[] };
    const fullKey  = `vbl_full:${ymd}:${slot}`; const full  = await kvGETjson(fullKey,  trace) || { items:[] };
    const items = (Array.isArray(union?.items) && union.items.length>0) ? union.items : (Array.isArray(full?.items) ? full.items : []);
    trace.push({ items_len: items.length, budget:{ used_before_total, used_before_slot, left_total, allow_this_run } });

    let afUpdated = 0, skipped_budget = 0, run_cap_reached = false, miss=0;
    const force = String(req.query.force||'0') === '1';

    for (const it of items){
      if ((allow_this_run - used_this_run) <= 0){ run_cap_reached = true; break; }

      const fixture_id = it?.fixture_id || it?.id || it?.fixtureId; if(!fixture_id){ miss++; continue; }
      const mtx = it?.markets || {};
      const haveAll = ['btts','ou25','fh_ou15','htft'].every(k => mtx[k] && Object.keys(mtx[k]).length);
      if (haveAll && !force) continue; // već popunjeno, čuvamo budžet

      // --- AF MAIN ---
      if ((allow_this_run - used_this_run) <= 0){ skipped_budget++; continue; }
      const main = await fetchAF_main(fixture_id, trace); used_this_run += 1;

      const markets = { ...(it?.markets||{}) };
      try{
        for (const r of (main?.payload?.response||[])){
          for (const bk of (r?.bookmakers||[])){
            const bkName = strip(bk?.name||bk?.title||bk?.key||'');
            const allow = process.env.ODDS_TRUSTED_ONLY==='1' ? TRUSTED.has(bkName) : true;
            if (!allow) continue;
            for (const bet of (bk?.bets||[])){
              const label = String(bet?.name||'').toLowerCase();
              // 1X2
              if(/match winner|1x2/.test(label)){
                const h = Number(bet?.values?.find(v=>/home|1/i.test(v?.value))?.odd);
                const a = Number(bet?.values?.find(v=>/away|2/i.test(v?.value))?.odd);
                if ((Number.isFinite(h)||Number.isFinite(a)) && impliedSumOk([h,a]) && inRange(h??1.8,1.15,10) && inRange(a??1.8,1.15,10)) { markets['1x2']={home:h??null, away:a??null}; afUpdated++; }
              }
              // BTTS
              if(/both teams to score|btts/.test(label)){
                const yes = Number(bet?.values?.find(v=>/yes/i.test(v?.value))?.odd);
                const no  = Number(bet?.values?.find(v=>/no/i.test(v?.value))?.odd);
                if ([yes,no].some(Number.isFinite) && impliedSumOk([yes,no])) { markets['btts']={ yes:yes??null, no:no??null }; afUpdated++; }
              }
              // OU 2.5 + FH 1.5
              if(/totals|over\/under|goals/.test(label)){
                const over25=Number(bet?.values?.find(v=>/(^|\s)over\s*2\.5/i.test(v?.value))?.odd);
                const under25=Number(bet?.values?.find(v=>/(^|\s)under\s*2\.5/i.test(v?.value))?.odd);
                if ((Number.isFinite(over25)||Number.isFinite(under25)) && impliedSumOk([over25,under25])) { markets['ou25']={ over:over25??null, under:under25??null }; afUpdated++; }
                if (/1st half|first half|fh/i.test(label)){
                  const ouO=Number(bet?.values?.find(v=>/(^|\s)over\s*1\.5/i.test(v?.value))?.odd);
                  const ouU=Number(bet?.values?.find(v=>/(^|\s)under\s*1\.5/i.test(v?.value))?.odd);
                  if ((Number.isFinite(ouO)||Number.isFinite(ouU)) && impliedSumOk([ouO,ouU])) { markets['fh_ou15']={ over:ouO??null, under:ouU??null }; afUpdated++; }
                }
              }
              // HT/FT
              if(/half time\/full time|ht\/ft|htft/.test(label)){
                const hh = Number(bet?.values?.find(v=>/home\/?home/i.test(v?.value))?.odd);
                const aa = Number(bet?.values?.find(v=>/away\/?away/i.test(v?.value))?.odd);
                if ((Number.isFinite(hh)&&inRange(hh,3,40)) || (Number.isFinite(aa)&&inRange(aa,3,40))) { markets['htft']={ hh:hh??null, aa:aa??null }; afUpdated++; }
              }
            }
          }
        }
      } catch(e){ trace.push({ af_parse_error_main:String(e?.message||e) }); }

      // --- FH DOPUNA ako treba ---
      const needFH = !(markets?.fh_ou15 && (Number.isFinite(markets.fh_ou15.over)||Number.isFinite(markets.fh_ou15.under)));
      if (needFH && (allow_this_run - used_this_run) > 0){
        const fh = await fetchAF_fh(fixture_id, trace); used_this_run += 1;
        try{
          for (const r of (fh?.payload?.response||[])){
            for (const bk of (r?.bookmakers||[])){
              const bkName = strip(bk?.name||bk?.title||bk?.key||'');
              const allow = process.env.ODDS_TRUSTED_ONLY==='1' ? TRUSTED.has(bkName) : true; if(!allow) continue;
              for (const bet of (bk?.bets||[])){
                const label = String(bet?.name||'').toLowerCase();
                if(/1st half|first half|fh/.test(label)){
                  const ouO=Number(bet?.values?.find(v=>/(^|\s)over\s*1\.5/i.test(v?.value))?.odd);
                  const ouU=Number(bet?.values?.find(v=>/(^|\s)under\s*1\.5/i.test(v?.value))?.odd);
                  if ((Number.isFinite(ouO)||Number.isFinite(ouU)) && impliedSumOk([ouO,ouU])) { markets['fh_ou15']={ over:ouO??null, under:ouU??null }; afUpdated++; }
                }
              }
            }
          }
        } catch(e){ trace.push({ af_parse_error_fh:String(e?.message||e) }); }
      }

      it.markets = mergeMarkets(it.markets, markets);
    }

    // ----- persist items -----
    const outFull = { ...(full||{}), items }; await kvSET(fullKey, outFull, trace);
    const unionOut = { ...(union||{}), items }; await kvSET(unionKey, unionOut, trace);

    // ----- persist budget -----
    const budAfter = await incAfBudget(ymd, slot, used_this_run, trace);

    const took = Date.now()-t0;
    return res.status(200).json({ ok:true, ymd, slot, af_updated:afUpdated, used_this_run, skipped_budget, run_cap_reached, took_ms:took, budget:{ before_total:used_before_total, before_slot:used_before_slot, allow_this_run, after_total:budAfter.total, after_slot:budAfter[slot] }, trace });
  } catch(e){
    const took = Date.now()-t0; return res.status(500).json({ ok:false, error:String(e?.message||e), took_ms:took });
  }
}
