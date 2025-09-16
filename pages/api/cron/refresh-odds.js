// pages/api/cron/refresh-odds.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGET(key, trace=[]) {
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const v = j?.result ?? j?.value ?? null;
      if (v==null) continue;
      const out = typeof v==="string" ? JSON.parse(v) : v;
      trace.push({kv:"hit", key, flavor:b.flavor, size: (Array.isArray(out?.items)?out.items.length: (Array.isArray(out)?out.length:0))});
      return out;
    } catch {}
  }
  trace.push({kv:"miss", key});
  return null;
}
async function kvSET(key, val, trace=[]) {
  const saves = [];
  for (const b of kvBackends()) {
    try {
      const body = typeof val==="string" ? val : JSON.stringify(val);
      const u = `${b.url}/set/${encodeURIComponent(key)}`;
      const r = await fetch(u, { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${b.tok}` }, body: JSON.stringify({ value: body }) });
      saves.push({ key, flavor:b.flavor, ok:r.ok });
    } catch (e) {
      saves.push({ key, flavor:b.flavor, ok:false, error:String(e?.message||e) });
    }
  }
  trace.push({kv:"set", key, saves});
  return saves;
}

/* ---------- API-Football ---------- */
const { afFetch } = require("../../../lib/sources/apiFootball");

/* ---------- Helpers ---------- */
const SLOT_ODDS_CAP = Number(process.env.SLOT_ODDS_CAP || 2000); // ~6000/dan budžet = 3×2000
const ODDS_PER_FIXTURE_CAP = Number(process.env.ODDS_PER_FIXTURE_CAP || 15);
function pickSlotAuto(now) {
  const h = hourInTZ(now, TZ);
  return (h<10) ? "late" : (h<15) ? "am" : "pm";
}
function slotFilter(dateISO, slot){
  if(!dateISO) return false;
  const d = new Date(dateISO);
  const h = hourInTZ(d, TZ);
  if (slot==="late") return h < 10;
  if (slot==="am")   return h >= 10 && h < 15;
  if (slot==="pm")   return h >= 15;
  return true;
}
function strip(x){ return String(x||"").trim().toLowerCase(); }
function mergeMarkets(orig, add){ const out={...(orig||{})}; for(const k of Object.keys(add||{})) out[k]={...(orig?.[k]||{}), ...(add?.[k]||{})}; return out; }

/* ---------- main ---------- */
export default async function handler(req, res){
  const trace = [];
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    let slot = String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot = pickSlotAuto(now);

    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;

    let union = await kvGET(unionKey, trace) || { items:[] };
    let full  = await kvGET(fullKey,  trace) || { items:[] };
    let items = Array.isArray(full?.items) && full.items.length ? full.items : (Array.isArray(union?.items)?union.items:[]);

    // Seed ako je prazno
    if (!items.length){
      const af = await afFetch("/fixtures", { date: ymd });
      const list = Array.isArray(af?.response) ? af.response : [];
      items = list
        .filter(f => f?.league?.name && !/u-?\d{2}|youth|reserve|women|futsal/i.test(f.league.name))
        .filter(f => slotFilter(f?.fixture?.date, slot))
        .map(f => ({
          fixture_id: f?.fixture?.id,
          fixture: { id: f?.fixture?.id, date: f?.fixture?.date, timezone: f?.fixture?.timezone },
          kickoff: f?.fixture?.date, kickoff_utc: f?.fixture?.date,
          league: { id: f?.league?.id, name: f?.league?.name, country: f?.league?.country, season: f?.league?.season },
          teams: { home: f?.teams?.home?.name, away: f?.teams?.away?.name, home_id: f?.teams?.home?.id, away_id: f?.teams?.away?.id },
          home: f?.teams?.home?.name, away: f?.teams?.away?.name,
          markets: {}
        }));
      await kvSET(fullKey,  { items }, trace);
      await kvSET(unionKey, { items }, trace);
      await kvSET(`vb:day:${ymd}:last`,  { items }, trace);
      await kvSET(`vb:day:${ymd}:union`, { items }, trace);
    }

    // Odds update sa cap + "skip if markets exist"
    let updated = 0, skipped = 0;
    const trustList = String(process.env.TRUSTED_BOOKIES||"")
      .split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
    const TRUSTED = new Set(trustList.length ? trustList : [
      "bet365","pinnacle","williamhill","marathonbet","unibet","888sport","skybet","betfair",
      "betway","ladbrokes","coral","bwin","1xbet","betano","stake","tipsport","efbet","parionsport","toto"
    ]);
    const trustedOnly = process.env.ODDS_TRUSTED_ONLY === "1";

    for (const it of items){
      if (updated >= SLOT_ODDS_CAP) break;
      const fid = it?.fixture_id || it?.fixture?.id;
      if (!fid) continue;

      // Skip ako već imamo makar jedan ključ tržišta
      const hasAnyMarket = it?.markets && (it.markets['1x2'] || it.markets['btts'] || it.markets['ou25'] || it.markets['fh_ou15'] || it.markets['htft']);
      if (hasAnyMarket) { skipped++; continue; }

      const data = await afFetch("/odds", { fixture: String(fid) });
      const books = Array.isArray(data?.response?.[0]?.bookmakers) ? data.response[0].bookmakers : [];
      let mk = it.markets || {};
      let perFixture = 0;

      for (const bk of books){
        if (perFixture >= ODDS_PER_FIXTURE_CAP) break;
        const name = strip(bk?.name||bk?.title||bk?.key);
        if (trustedOnly && !TRUSTED.has(name)) continue;

        for (const bet of (bk?.bets||[])){
          if (perFixture >= ODDS_PER_FIXTURE_CAP) break;
          const label = String(bet?.name||"").toLowerCase();

          // 1X2 / Match Winner
          if(/match winner|1x2/.test(label)){
            const h = Number(bet?.values?.find(v=>/home|1\b/i.test(v?.value))?.odd);
            const d = Number(bet?.values?.find(v=>/draw|x\b/i.test(v?.value))?.odd);
            const a = Number(bet?.values?.find(v=>/away|2\b/i.test(v?.value))?.odd);
            if (Number.isFinite(h)||Number.isFinite(d)||Number.isFinite(a)){
              mk['1x2'] = { ...(mk['1x2']||{}), home: h??mk['1x2']?.home??null, draw:d??mk['1x2']?.draw??null, away:a??mk['1x2']?.away??null };
              perFixture++;
            }
          }
          // BTTS
          if(/both teams to score|btts/.test(label)){
            const yes = Number(bet?.values?.find(v=>/yes/i.test(v?.value))?.odd);
            const no  = Number(bet?.values?.find(v=>/no/i.test(v?.value))?.odd);
            if (Number.isFinite(yes)||Number.isFinite(no)){
              mk['btts'] = { ...(mk['btts']||{}), yes: yes??mk['btts']?.yes??null, no: no??mk['btts']?.no??null };
              perFixture++;
            }
          }
          // OU 2.5
          if(/over\/under|total goals/.test(label)){
            const vOver = bet?.values?.find(v => /over/i.test(v?.value) && /2\.5/.test(v?.value));
            const vUnder= bet?.values?.find(v => /under/i.test(v?.value) && /2\.5/.test(v?.value));
            const over = Number(vOver?.odd), under = Number(vUnder?.odd);
            if (Number.isFinite(over)||Number.isFinite(under)){
              mk['ou25'] = { ...(mk['ou25']||{}), over: over??mk['ou25']?.over??null, under: under??mk['ou25']?.under??null };
              perFixture++;
            }
          }
          // FH OU 1.5
          if(/goals in 1st half|1st half - over\/under|1st half total/i.test(label)){
            const vOver = bet?.values?.find(v => /over/i.test(v?.value) && /(1\.5|1,5)/.test(v?.value));
            const vUnder= bet?.values?.find(v => /under/i.test(v?.value) && /(1\.5|1,5)/.test(v?.value));
            const over = Number(vOver?.odd), under = Number(vUnder?.odd);
            if (Number.isFinite(over)||Number.isFinite(under)){
              mk['fh_ou15'] = { ...(mk['fh_ou15']||{}), over: over??mk['fh_ou15']?.over??null, under: under??mk['fh_ou15']?.under??null };
              perFixture++;
            }
          }
          // HT/FT
          if(/half time\/full time|ht\/ft|double result/i.test(label)){
            const vv = code => Number(bet?.values?.find(v=>new RegExp(code,'i').test(v?.value))?.odd);
            const hh=vv('home\\/home|^hh$'), hd=vv('home\\/draw|^hd$'), ha=vv('home\\/away|^ha$');
            const dh=vv('draw\\/home|^dh$'), dd=vv('draw\\/draw|^dd$'), da=vv('draw\\/away|^da$');
            const ah=vv('away\\/home|^ah$'), ad=vv('away\\/draw|^ad$'), aa=vv('away\\/away|^aa$');
            if ([hh,hd,ha,dh,dd,da,ah,ad,aa].some(Number.isFinite)){
              mk['htft'] = { ...(mk['htft']||{}), hh, hd, ha, dh, dd, da, ah, ad, aa };
              perFixture++;
            }
          }
        }
      }

      it.markets = mergeMarkets(it.markets||{}, mk);
      updated++;

      // persist back (full only)
      await kvSET(fullKey, { items }, trace);
    }

    return res.status(200).json({ ok:true, ymd, slot, updated, skipped, items_len: items.length, trace });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
