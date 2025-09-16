// pages/api/cron/refresh-odds.js
export const config = { api: { bodyParser: false } };

/* =========================
 *  Inline helpers (KV + math)
 * ========================= */
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
      const v = (j && ("result" in j ? j.result : j.value)) ?? null;
      if (v==null) continue;
      trace.push({ get:key, ok:true, flavor:b.flavor, hit:true });
      return v;
    } catch {}
  }
  trace.push({ get:key, ok:true, hit:false });
  return null;
}
async function kvSET(key, value, trace=[]) {
  const v = typeof value === "string" ? value : JSON.stringify(value);
  let ok = false;
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/set/${encodeURIComponent(key)}`;
      const r = await fetch(u, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.tok}`, "Content-Type":"application/json" },
        body: JSON.stringify({ value: v })
      });
      ok = ok || r.ok;
      trace.push({ kv:"set", key, flavor:b.flavor, ok: !!r.ok });
    } catch {}
  }
  return ok;
}
function kvToItems(doc) {
  if (doc == null) return { items: [] };
  let v = doc;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { items: [] }; } }
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return { items: [] }; }
  }
  if (Array.isArray(v)) return { items: v };
  if (v && Array.isArray(v.items)) return v;
  return { items: [] };
}
// math helpers
function median(arr){ const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!a.length) return NaN; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function trimmedMean(arr, trim=0.15){ const a=arr.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!a.length) return NaN; const k=Math.floor(a.length*trim); const b=a.slice(k,a.length-k); return b.reduce((p,c)=>p+c,0)/b.length; }
function consensusPrice(list){ const m=median(list); if (Number.isFinite(m)) return m; const t=trimmedMean(list,0.15); return Number.isFinite(t)?t:NaN; }

/* =========================
 *  ENV / time helpers
 * ========================= */
const TZ = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
const SLOT_ODDS_CAP_LATE = Number(process.env.SLOT_ODDS_CAP_LATE || 1200);
const SLOT_ODDS_CAP_AM   = Number(process.env.SLOT_ODDS_CAP_AM   || 2400);
const SLOT_ODDS_CAP_PM   = Number(process.env.SLOT_ODDS_CAP_PM   || 2400);
const BACKOFF_MINUTES_EMPTY = Number(process.env.ODDS_BACKOFF_MINUTES || 25);

const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour12:false, hour:"2-digit"}).format(d));
function pickSlot(now) { const h=hourInTZ(now,TZ); return h<10?"late":h<15?"am":"pm"; }
function capForSlot(slot){ if (slot==="late") return SLOT_ODDS_CAP_LATE; if (slot==="am") return SLOT_ODDS_CAP_AM; return SLOT_ODDS_CAP_PM; }
function leagueTier(leagueName=""){ const s=String(leagueName).toLowerCase(); if(/uefa|champions|europa|conference/.test(s))return 1; if(/premier league|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira|championship|mls/.test(s))return 2; return 3; }

/* =========================
 *  API-Football client + parsing
 * ========================= */
async function afOddsByFixture(fixtureId, apiKey){
  const url = `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`;
  const r = await fetch(url, { headers: { "x-apisports-key": apiKey }, cache:"no-store" });
  if (!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j;
}

function extractConsensusMarkets(afResponse){
  const out = {};
  const resp = afResponse?.response || [];

  // 1x2
  const p1x2 = { home:[], draw:[], away:[] };
  for (const bm of resp?.[0]?.bookmakers || []) {
    for (const b of bm.bets || []) {
      const label = (b.name || "").toLowerCase();
      if (/match winner|1x2|win\/draw\/win/.test(label)) {
        for (const v of b.values || []) {
          const val = (v.value||"").toLowerCase();
          const odd = Number(v.odd);
          if (!Number.isFinite(odd)) continue;
          if (/(home|1|local)/.test(val)) p1x2.home.push(odd);
          else if (/(draw|x)/.test(val)) p1x2.draw.push(odd);
          else if (/(away|2|visitor)/.test(val)) p1x2.away.push(odd);
        }
      }
    }
  }
  const m1x2 = {};
  if (p1x2.home.length) m1x2.home = consensusPrice(p1x2.home);
  if (p1x2.draw.length) m1x2.draw = consensusPrice(p1x2.draw);
  if (p1x2.away.length) m1x2.away = consensusPrice(p1x2.away);
  if (Object.keys(m1x2).length) out["1x2"] = m1x2;

  // BTTS
  const bttsPrices = { yes:[], no:[] };
  for (const bm of resp?.[0]?.bookmakers || []) {
    for (const b of bm.bets || []) {
      const label = (b.name || "").toLowerCase();
      if (/both teams to score|btts/.test(label)) {
        for (const v of b.values || []) {
          const val = (v.value||"").toLowerCase();
          const odd = Number(v.odd);
          if (!Number.isFinite(odd)) continue;
          if (/yes|y/.test(val)) bttsPrices.yes.push(odd);
          else if (/no|n/.test(val)) bttsPrices.no.push(odd);
        }
      }
    }
  }
  const btts = {};
  if (bttsPrices.yes.length) btts.yes = consensusPrice(bttsPrices.yes);
  if (bttsPrices.no.length)  btts.no  = consensusPrice(bttsPrices.no);
  if (Object.keys(btts).length) out.btts = btts;

  // OU 2.5
  const ou25 = { over:[], under:[] };
  for (const bm of resp?.[0]?.bookmakers || []) {
    for (const b of bm.bets || []) {
      const label = (b.name || "").toLowerCase();
      if (/over\/under|goals over\/under/.test(label)) {
        for (const v of b.values || []) {
          const val = (v.value||"").toLowerCase().replace(/\s+/g,'');
          const odd = Number(v.odd);
          if (!Number.isFinite(odd)) continue;
          if (/(o|over)2\.?5/.test(val)) ou25.over.push(odd);
          else if (/(u|under)2\.?5/.test(val)) ou25.under.push(odd);
        }
      }
    }
  }
  const ou = {};
  if (ou25.over.length)  ou.over  = consensusPrice(ou25.over);
  if (ou25.under.length) ou.under = consensusPrice(ou25.under);
  if (Object.keys(ou).length) out.ou25 = ou;

  // FH OU 1.5
  const fh = { over:[], under:[] };
  for (const bm of resp?.[0]?.bookmakers || []) {
    for (const b of bm.bets || []) {
      const label = (b.name || "").toLowerCase();
      if (/1st half.*over|over\/under.*1st half|first half.*over/.test(label)) {
        for (const v of b.values || []) {
          const val = (v.value||"").toLowerCase().replace(/\s+/g,'');
          const odd = Number(v.odd);
          if (!Number.isFinite(odd)) continue;
          if (/(o|over)1\.?5/.test(val)) fh.over.push(odd);
          else if (/(u|under)1\.?5/.test(val)) fh.under.push(odd);
        }
      }
    }
  }
  const fh_ou15 = {};
  if (fh.over.length)  fh_ou15.over  = consensusPrice(fh.over);
  if (fh.under.length) fh_ou15.under = consensusPrice(fh.under);
  if (Object.keys(fh_ou15).length) out.fh_ou15 = fh_ou15;

  // HT/FT
  const htftMap = { hh:[], hd:[], ha:[], dh:[], dd:[], da:[], ah:[], ad:[], aa:[] };
  for (const bm of resp?.[0]?.bookmakers || []) {
    for (const b of bm.bets || []) {
      const label = (b.name || "").toLowerCase();
      if (/half time\/full time|ht\/ft|double result/.test(label)) {
        for (const v of b.values || []) {
          const val = (v.value||"").toLowerCase().replace(/[\s/-]/g,'');
          const odd = Number(v.odd);
          if (!Number.isFinite(odd)) continue;
          const map = (s) => s.replace(/home/g,'h').replace(/away/g,'a').replace(/draw|x/g,'d').slice(0,2);
          const code = map(val);
          if (htftMap[code]) htftMap[code].push(odd);
        }
      }
    }
  }
  const htft = {};
  for (const k of Object.keys(htftMap)) if (htftMap[k].length) htft[k] = consensusPrice(htftMap[k]);
  if (Object.keys(htft).length) out.htft = htft;

  return out;
}

/* =========================
 *  Handler
 * ========================= */
export default async function handler(req, res){
  const trace = [];
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    let slot = String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot = pickSlot(now);

    // READ API KEY — supports your 'API_FOOTBALL_KEY'
    const apiKey =
      process.env.APIFOOTBALL_KEY ||
      process.env.API_FOOTBALL_KEY ||
      process.env.APISPORTS_KEY ||
      process.env.APISPORTS_API_KEY ||
      process.env.X_APISPORTS_KEY;
    if (!apiKey) {
      return res.status(200).json({
        ok:false,
        error:"API-Football key missing (tried: APIFOOTBALL_KEY, API_FOOTBALL_KEY, APISPORTS_KEY, APISPORTS_API_KEY, X_APISPORTS_KEY)"
      });
    }

    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;
    const union = kvToItems(await kvGET(unionKey, trace));
    const full  = kvToItems(await kvGET(fullKey,  trace));

    const items = (full.items.length ? full.items : union.items).slice();

    // Prioritet: bez markets prvo, pa UEFA/top5
    items.sort((a,b)=>{
      const ma = a?.markets ? 1 : 0, mb = b?.markets ? 1 : 0;
      if (ma!==mb) return ma-mb;
      const la = leagueTier(a?.league?.name), lb = leagueTier(b?.league?.name);
      return la-lb;
    });

    const CAP = capForSlot(slot);
    let updated = 0, skipped = 0;

    for (const f of items) {
      if (updated >= CAP) break;

      const id = f.fixture_id || f.fixture?.id;
      if (!id) { skipped++; continue; }

      // skip-if-markets-exist
      if (f.markets && (f.markets.btts || f.markets.ou25 || f.markets.fh_ou15 || f.markets.htft || f.markets["1x2"])) {
        skipped++; continue;
      }

      // backoff kada AF ranije vrati prazno
      const missKey = `af:miss:${id}`;
      const missRaw = await kvGET(missKey, trace);
      if (missRaw && typeof missRaw === "string") {
        const until = new Date(missRaw);
        if (Date.now() < until.getTime()) { skipped++; continue; }
      }

      const af = await afOddsByFixture(id, apiKey);
      const markets = extractConsensusMarkets(af);

      if (!markets || Object.keys(markets).length === 0) {
        const until = new Date(Date.now() + BACKOFF_MINUTES_EMPTY*60*1000).toISOString();
        await kvSET(missKey, until, trace);
        skipped++; continue;
      }

      f.markets = Object.assign({}, f.markets || {}, markets);
      updated++;
    }

    await kvSET(fullKey, { items }, trace);

    return res.status(200).json({ ok:true, ymd, slot, updated, skipped, items_len: items.length, trace });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
