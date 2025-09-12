// pages/api/cron/refresh-odds.js
// Enrich odds for today's slot; builds trusted consensus per market (1X2, BTTS, OU2.5, HT-FT)
// Sources: API-SPORTS v3 (primary). Odds-API optional (h2h/totals) but capped by OA_DAILY_CAP.
// Writes a light union snapshot into KV so /cron/rebuild can filter + create tickets.

export const config = { api: { bodyParser: false } };

/* ---------------- ENV ---------------- */
const TZ = process.env.TZ || "Europe/Belgrade";

// API-SPORTS
const AF_BASE = (process.env.FOOTBALL_API_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/, "");
const AF_KEY  = (process.env.FOOTBALL_API_KEY || process.env.NEXT_PUBLIC_FOOTBALL_API_KEY || "").trim();

// Odds-API (optional; we still keep daily cap=15 by default)
const OA_BASE = (process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4").replace(/\/+$/, "");
const OA_KEY  = (process.env.ODDS_API_KEY || "").trim();
const OA_DAILY_CAP = Math.max(1, Number(process.env.ODDS_API_DAILY_CAP || 15) || 15);
const OA_REGION = (process.env.ODDS_API_REGION || "eu").trim();
const OA_MARKETS = (process.env.ODDS_API_MARKETS || "h2h,totals").trim(); // BTTS/HTFT nisu podržani na OA

// Trust & filters
const TRUSTED_BOOKIES = new Set(
  String(process.env.TRUSTED_BOOKIES || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const SHARP_BOOKIES = new Set(
  String(process.env.SHARP_BOOKIES || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const ODDS_TRUSTED_ONLY = String(process.env.ODDS_TRUSTED_ONLY || "1") === "1";

// KV (Vercel KV / Upstash Redis REST)
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try{
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers:{Authorization:`Bearer ${b.tok}`}, cache:"no-store" });
      const ok = r.ok; const j = ok ? await r.json().catch(()=>null) : null;
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      trace && trace.push({ key, flavor:b.flavor, status: ok ? (val?"hit":"miss") : `http-${r.status}` });
      if (val) return { raw: val, flavor: b.flavor };
    }catch(e){ trace && trace.push({ key, flavor:b.flavor, status:`err:${String(e?.message||e)}` }); }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value, trace){
  const payload = JSON.stringify(value);
  for (const b of kvBackends()) {
    try{
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method:"POST",
        headers:{Authorization:`Bearer ${b.tok}`,"Content-Type":"application/json"},
        body: JSON.stringify({ value: payload })
      });
      trace && trace.push({ key, flavor:b.flavor+":rw", ok:r.ok });
    }catch(e){ trace && trace.push({ key, flavor:b.flavor+":rw", ok:false, err:String(e?.message||e) }); }
  }
}

/* ---------------- utils ---------------- */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
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

function safeNum(x, d=0){ const n = Number(x); return Number.isFinite(n) ? n : d; }
function median(arr){ if (!arr?.length) return null; const a=[...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2? a[m] : (a[m-1]+a[m])/2; }
function spread(arr){
  if (!arr?.length) return null;
  const mn = Math.min(...arr), mx = Math.max(...arr);
  const mid = median(arr) || ((mn+mx)/2);
  return mid>0 ? (mx - mn)/mid : null;
}

/* -------- API-Sports odds reader (per fixture) ---------- */
async function afGET(path, params){
  const url = new URL(AF_BASE + path);
  for (const [k,v] of Object.entries(params||{})) if (v!==undefined && v!==null && v!=="") url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers:{ "x-apisports-key": AF_KEY }, cache:"no-store" });
  if (!r.ok) return { ok:false, status:r.status, data:null };
  const j = await r.json().catch(()=>null);
  return { ok:true, status:200, data:j };
}

function normBookName(s){ return String(s||"").trim().toLowerCase(); }
function isTrustedBook(name){
  const n = normBookName(name);
  if (!n) return false;
  if (TRUSTED_BOOKIES.size) return TRUSTED_BOOKIES.has(n);
  return SHARP_BOOKIES.has(n); // fallback ako je definisan samo SHARP
}

function pickMarketName(raw){
  const s = String(raw||"").toLowerCase();
  if (s.includes("both teams to score") || s.includes("btts")) return "BTTS";
  if (s.includes("over/under") || s.includes("goals over/under") || s.includes("totals")) return "OU";
  if (s.includes("half time/full time") || s.includes("ht/ft")) return "HTFT";
  if (s.includes("match winner") || s==="1x2" || s.includes("winner")) return "1X2";
  return "";
}

/** Extract consensus for a required selection from many books. 
 * returns: {price, books_count, trusted_count, price_spread, selection_label}
 */
function consensusFor(selectionOffers){
  const trusted = selectionOffers.filter(o => !ODDS_TRUSTED_ONLY || o.trusted);
  const pool = (ODDS_TRUSTED_ONLY ? trusted : selectionOffers);
  if (!pool.length) return null;
  const prices = pool.map(o => o.price).filter(x => Number.isFinite(x) && x > 1.0);
  if (!prices.length) return null;
  const price = median(prices);    // robustno
  const s = spread(prices);
  return {
    price,
    books_count: prices.length,
    trusted_count: trusted.length,
    price_spread: s,
    selection_label: selectionOffers[0]?.label || ""
  };
}

/** Build per-market consensus (1X2, BTTS, OU 2.5, HTFT) from API-Sports structure. */
function buildConsensusFromAF(afOdds){
  // API-Sports odds format: response -> bookmakers[] -> bets[] -> values[]
  // We normalize into selectionOffers per logical market
  const out = { H2H:null, BTTS:null, OU25:null, HTFT:null };

  if (!afOdds?.response?.length) return out;

  const selectionMap = {
    "1X2": { // values: Home, Draw, Away
      key:"H2H",
      match: (bet)=> pickMarketName(bet?.name)==="1X2",
      extract: (book, bet)=> (bet?.values||[]).map(v=>({
        label: (v.value||"").trim(),                // "Home"/"Draw"/"Away"
        price: safeNum(v.odd),
        book: book?.name, trusted: isTrustedBook(book?.name),
      }))
    },
    "BTTS": {
      key:"BTTS",
      match: (bet)=> pickMarketName(bet?.name)==="BTTS",
      extract: (book, bet)=> (bet?.values||[]).map(v=>({
        label: (v.value||"").trim(),                // "Yes"/"No"
        price: safeNum(v.odd),
        book: book?.name, trusted: isTrustedBook(book?.name),
      }))
    },
    "OU": {
      key:"OU25",
      match: (bet)=> pickMarketName(bet?.name)==="OU",
      extract: (book, bet)=> {
        // biramo baš liniju 2.5
        const values = (bet?.values||[]).filter(v => String(v?.value||"").includes("2.5") || String(v?.handicap||"") === "2.5");
        return values.map(v=>({
          label: (v.value||v.selection||"").trim(),  // "Over 2.5" / "Under 2.5"
          price: safeNum(v.odd),
          book: book?.name, trusted: isTrustedBook(book?.name),
        }));
      }
    },
    "HTFT": {
      key:"HTFT",
      match: (bet)=> pickMarketName(bet?.name)==="HTFT",
      extract: (book, bet)=> (bet?.values||[]).map(v=>({
        label: (v.value||"").trim(),                // "Home/Home", "Draw/Away", ...
        price: safeNum(v.odd),
        book: book?.name, trusted: isTrustedBook(book?.name),
      }))
    }
  };

  const buckets = { H2H:[], BTTS:[], OU25:[], HTFT:[] };

  for (const bm of (afOdds.response[0]?.bookmakers || [])) {
    for (const bet of (bm?.bets || [])) {
      for (const key of Object.keys(selectionMap)) {
        const cfg = selectionMap[key];
        if (cfg.match(bet)) {
          const offers = cfg.extract(bm, bet).filter(o => o.price > 1.0);
          buckets[cfg.key].push(...offers);
        }
      }
    }
  }

  // Make per-selection consensus (choose the best selection by *highest* price? No — only store each selection's consensus;
  // actual pick will be decided in /cron/rebuild using model EV).
  function pack(list, labelPredicate){
    const arr = list.filter(o => labelPredicate(String(o.label || "")));
    if (!arr.length) return null;
    return consensusFor(arr);
  }

  // For H2H we store three consensuses
  if (buckets.H2H.length){
    out.H2H = {
      home: pack(buckets.H2H, s=>/^home$/i.test(s)),
      draw: pack(buckets.H2H, s=>/^draw$/i.test(s)),
      away: pack(buckets.H2H, s=>/^away$/i.test(s)),
    };
  }
  if (buckets.BTTS.length){
    out.BTTS = {
      yes: pack(buckets.BTTS, s=>/^yes$/i.test(s)),
      no:  pack(buckets.BTTS, s=>/^no$/i.test(s)),
    };
  }
  if (buckets.OU25.length){
    out.OU25 = {
      over: pack(buckets.OU25, s=>/over/i.test(s)),
      under: pack(buckets.OU25, s=>/under/i.test(s)),
    };
  }
  if (buckets.HTFT.length){
    // we keep map by exact label to allow EV on any combo
    const map = {};
    for (const lab of ["Home/Home","Home/Draw","Home/Away","Draw/Home","Draw/Draw","Draw/Away","Away/Home","Away/Draw","Away/Away"]){
      const c = pack(buckets.HTFT, s=> s.toLowerCase() === lab.toLowerCase());
      if (c) map[lab] = c;
    }
    out.HTFT = map;
  }

  return out;
}

/* ---------------- main handler ---------------- */
export default async function handler(req, res){
  const trace = [];
  try{
    res.setHeader("Cache-Control","no-store");
    const q = req.query||{};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const slot = String(q.slot||"").trim() || deriveSlot(hourInTZ(now, TZ));
    const force = String(q.force||"") === "1";

    // 1) pročitamo listu kandidata iz union/list ključa (već je popunjeno snapshotom)
    const pickedKey = `vb:day:${ymd}:${slot}`;
    const { raw } = await kvGETraw(`vb:day:${ymd}:${slot}:union`, trace);
    const baseArr = J(raw);
    const list = Array.isArray(baseArr) ? baseArr : [];

    const inspected = [];
    const odds_payload = [];
    let oaCalls = 0;

    for (const it of list){
      const fixture = it?.fixture_id || it?.fixture?.id || it?.id;
      if (!fixture) continue;

      // API-Sports odds by fixture
      const af = await afGET("/odds", { fixture });
      inspected.push({ host: AF_BASE, tag:"odds", path:"/odds", params:{fixture}, status: af.status, ok: af.ok, results: af.data?.results||0, errors:[] });

      if (af.ok && af.data?.results){
        const consensus = buildConsensusFromAF(af.data);
        odds_payload.push({ fixture, ok:true, consensus });
      }

      // Optional Odds-API call for h2h/totals (capped)
      if (OA_KEY && oaCalls < OA_DAILY_CAP && force){
        try{
          const url = new URL(`${OA_BASE}/sports/soccer/odds`);
          url.searchParams.set("apiKey", OA_KEY);
          url.searchParams.set("regions", OA_REGION);
          url.searchParams.set("markets", OA_MARKETS);
          url.searchParams.set("dateFormat", "iso");
          // NOTE: OA ne radi per-fixture; ostavljamo samo signal za debug
          const r = await fetch(url, { cache:"no-store" });
          const ok = r.ok; const count = ok ? (await r.json().catch(()=>[])).length : 0;
          oaCalls++;
          inspected.push({ host: OA_BASE, path:"/sports/soccer/odds", region:OA_REGION, market:OA_MARKETS, status:r.status, ok, count });
        }catch{}
      }
    }

    // 2) Snimimo “af odds enrichment” kao union ključ dana i slot-a (lagani payload)
    //    Ključ: vb:day:YYYY-MM-DD:union:odds  (čuva consensus per fixture)
    const saveKey = `vb:day:${ymd}:${slot}:odds`;
    await kvSET(saveKey, { slot, ymd, odds: odds_payload }, trace);

    return res.status(200).json({
      ok:true, ymd, slot,
      inspected: inspected.length,
      targeted: list.length,
      touched: inspected.length,
      source: `refresh-odds:vb:day:${ymd}:${slot}`,
      debug:{ tried: inspected, oa_summary:{ calls: oaCalls, budget_per_day: OA_DAILY_CAP } }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e), debug:{ trace } });
  }
}
