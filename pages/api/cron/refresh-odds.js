// pages/api/cron/refresh-odds.js
// Seed-uje/refresh-uje odds za dati slot i dan, sa pametnim fallback-om na KV.
// Redosled izvora: vbl_full:<YMD>:<slot> → vb:day:<YMD>:<slot> → vb:day:<YMD>:(union|last) → API-Football fixtures (all pages).
// Slot-filter (Europe/Belgrade): late 00–09, am 10–14, pm 15–23.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";
const AF_BASE = "https://v3.football.api-sports.io";

/* ---------------- KV helpers ---------------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key, diag) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store",
      });
      if (!r.ok) { diag && diag.push({ key, flavor:b.flavor, status:`http-${r.status}` }); continue; }
      const j = await r.json().catch(()=>null);
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      diag && diag.push({ key, flavor:b.flavor, status: val ? "hit" : "miss-null" });
      if (val) return { raw: val, flavor: b.flavor };
    } catch(e) {
      diag && diag.push({ key, flavor:b.flavor, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw: null, flavor: null };
}
async function kvSETjsonAll(key, valObj) {
  const val = JSON.stringify(valObj);
  const backends = kvBackends();
  const saved = [];
  for (const b of backends) {
    try {
      if (b.flavor === "vercel-kv") {
        const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${b.tok}`, "content-type":"application/json" },
          body: JSON.stringify({ value: val }),
        });
        if (r.ok) saved.push(b.flavor);
      } else {
        const r = await fetch(`${b.url}/pipeline`, {
          method: "POST",
          headers: { Authorization: `Bearer ${b.tok}`, "content-type":"application/json" },
          body: JSON.stringify([{ command: "SET", args: [key, val] }]),
        });
        if (r.ok) saved.push(b.flavor);
      }
    } catch {}
  }
  return { any: saved.length>0, backends: saved };
}
function toObj(s){ if(!s) return null; try{ return JSON.parse(s); }catch{ return null; } }
function arrFromAny(x){
  if(!x) return null;
  if(Array.isArray(x)) return x;
  if(Array.isArray(x?.items)) return x.items;
  if(Array.isArray(x?.value_bets)) return x.value_bets;
  if(Array.isArray(x?.football)) return x.football;
  if(Array.isArray(x?.list)) return x.list;
  if(Array.isArray(x?.data)) return x.data;
  if(x && typeof x==="object" && typeof x.value==="string"){
    try{ const v = JSON.parse(x.value); if(Array.isArray(v)) return v; }catch{}
  }
  return null;
}

/* --------------- time helpers --------------- */
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"});
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{timeZone:tz,hour:"2-digit",hour12:false});
  return parseInt(fmt.format(d),10);
}
// USKLAĐENO:
function deriveSlot(h){ if(h<10) return "late"; if(h<15) return "am"; return "pm"; }

/* --------------- slot helpers --------------- */
function kickoffFromMeta(meta){
  const s =
    meta?.kickoff_utc ||
    meta?.datetime_local?.starting_at?.date_time ||
    meta?.fixture?.date ||
    null;
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function inSlotLocal(meta, slot){
  const d = kickoffFromMeta(meta);
  if (!d) return false; // ovde smo striktni (seed ne popušta bez vremena)
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}

/* --------------- API-Football --------------- */
function getAFKey(){ return process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY || ""; }
async function afFetch(path, params={}){
  const key = getAFKey();
  if(!key) throw new Error("Missing API-Football key");
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k,v]) => { if (v != null) url.searchParams.set(k, String(v)); });
  const r = await fetch(url, { headers: { "x-apisports-key": key }, cache: "no-store" });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  if (!ct.includes("application/json")) throw new Error(`API-Football non-JSON (${r.status}) ${text.slice(0,120)}`);
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!j) throw new Error("API-Football parse error");
  return j;
}

/* -------- fetch ALL fixture pages for date -------- */
async function fetchAllFixturesForDate(ymd){
  let page = 1, all = [];
  const HARD_CAP_PAGES = 12; // safety
  while (page <= HARD_CAP_PAGES) {
    const jf = await afFetch("/fixtures", { date: ymd, timezone: TZ, page });
    const arr = Array.isArray(jf?.response) ? jf.response : [];
    all.push(...arr);
    const cur = Number(jf?.paging?.current || page);
    const tot = Number(jf?.paging?.total || page);
    if (!tot || cur >= tot) break;
    page++;
    await new Promise(r=>setTimeout(r, 120));
  }
  all.sort((a,b)=> new Date(a?.fixture?.date||0) - new Date(b?.fixture?.date||0));
  return all;
}

/* --------------- odds helpers --------------- */
function uniqNums(a){ const s=new Set(); for(const v of a||[]){ const n=Number(v); if(Number.isFinite(n)&&n>0)s.add(n);} return [...s]; }

function best1x2FromBookmakers(bookmakers){
  let best = null, books = 0;
  for(const b of bookmakers||[]){
    books++;
    for(const bet of b.bets||[]){
      const name = String(bet.name||"").toLowerCase();
      if(!(name.includes("match winner") || name==="1x2" || name.includes("winner"))) continue;
      const vals = bet.values||[];
      const vHome = vals.find(v=>/^home$/i.test(v.value||""));
      const vDraw = vals.find(v=>/^draw$/i.test(v.value||""));
      const vAway = vals.find(v=>/^away$/i.test(v.value||""));
      if(!(vHome && vDraw && vAway)) continue;
      const oH = parseFloat(vHome.odd), oD = parseFloat(vDraw.odd), oA = parseFloat(vAway.odd);
      if(!isFinite(oH)||!isFinite(oD)||!isFinite(oA)) continue;
      const pH = 1/oH, pD = 1/oD, pA = 1/oA, S = pH+pD+pA;
      const arr = [
        {code:"1", label:"Home", prob:pH/S, price:oH},
        {code:"X", label:"Draw", prob:pD/S, price:oD},
        {code:"2", label:"Away", prob:pA/S, price:oA},
      ].sort((a,b)=>b.prob-a.prob);
      const pick = arr[0];
      if(!best || pick.prob>best.prob || (Math.abs(pick.prob-best.prob)<1e-9 && pick.price<best.price)){
        best = { pick_code: pick.code, pick: pick.label, model_prob: pick.prob, price: pick.price };
      }
    }
  }
  if(best) best.books_count = books || 1;
  return best;
}

/* ------------------- handler ------------------- */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");

    const q = req.query||{};
    const now = new Date();
    const ymd = (q.ymd && String(q.ymd).match(/^\d{4}-\d{2}-\d{2}$/)) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
    const force = String(q.force ?? "0")==="1";

    if(!getAFKey()) {
      return res.status(200).json({ ok:false, ymd, slot, error:"API-Football key missing", source:"refresh-odds" });
    }

    // --------- 0) spremi listu kandidata iz KV ili API, sa evidencijom šta je pokušaо
    const tried = [];
    let pickedKey = null;
    let list = null;              // lista objekata sa {fixture_id,...} ili full fixtures
    let metaById = {};            // minimalna meta per id

    // A) vbl_full:<ymd>:<slot>
    tried.push(`vbl_full:${ymd}:${slot}`);
    const rawVblFull = (await kvGETraw(`vbl_full:${ymd}:${slot}`)).raw;
    const arrVblFull = arrFromAny(toObj(rawVblFull));
    if (arrVblFull && arrVblFull.length) {
      pickedKey = `vbl_full:${ymd}:${slot}`;
      list = arrVblFull;
    }

    // B) vb:day:<ymd>:<slot> (boxed)
    if (!list) {
      tried.push(`vb:day:${ymd}:${slot}`);
      const rawBox = (await kvGETraw(`vb:day:${ymd}:${slot}`)).raw;
      const arrBox = arrFromAny(toObj(rawBox));
      if (arrBox && arrBox.length) {
        pickedKey = `vb:day:${ymd}:${slot}`;
        list = arrBox;
      }
    }

    // C) vb:day:<ymd>:(union|last)
    if (!list) {
      for (const k of [`vb:day:${ymd}:union`, `vb:day:${ymd}:last`]) {
        tried.push(k);
        const raw = (await kvGETraw(k)).raw;
        const arr = arrFromAny(toObj(raw));
        if (arr && arr.length) { pickedKey = k; list = arr; break; }
      }
    }

    // D) API fixtures (all pages) — kao poslednji fallback
    let inspected = 0, filtered = 0;
    if (!list) {
      tried.push("fixtures:all-pages");
      const all = await fetchAllFixturesForDate(ymd);
      inspected = all.length;
      // mapiraj meta
      for (const it of all) {
        const id = Number(it?.fixture?.id);
        if (!id) continue;
        metaById[id] = {
          league: it?.league,
          teams:  it?.teams,
          datetime_local: { starting_at: { date_time: (it?.fixture?.date || "").replace("T"," ").replace("Z","") } },
          kickoff_utc: it?.fixture?.date || null,
        };
      }
      const rows = all.map(it => {
        const id = Number(it?.fixture?.id);
        return id ? { id, meta: metaById[id] } : null;
      }).filter(Boolean);

      const slotRows = rows.filter(r => inSlotLocal(r.meta, slot));
      filtered = slotRows.length;
      const ids = slotRows.slice(0, 60).map(r => r.id);
      list = ids.map(id => ({ fixture_id: id, ...(metaById[id] ? { ...metaById[id] } : {}) }));
      pickedKey = "fixtures:all-pages";
    } else {
      // meta iz KV zapisa (vbl_full / vb:day*) — ponovo provuci slot za svaki slučaj
      const norm = [];
      for (const it of list) {
        const id = Number(it?.fixture_id ?? it?.fixture?.id ?? it?.id ?? it);
        if (!id) continue;
        const meta = {
          league: it?.league || it?.league_obj || null,
          teams:  it?.teams || { home: it?.home ? { name: it.home } : null, away: it?.away ? { name: it.away } : null },
          datetime_local: it?.datetime_local || (it?.kickoff_utc
            ? { starting_at: { date_time: String(it.kickoff_utc).replace("T"," ").replace("Z","") } }
            : null),
          kickoff_utc: it?.kickoff_utc || it?.fixture?.date || null,
          fixture: it?.fixture || null,
        };
        if (inSlotLocal(meta, slot)) {
          norm.push({ fixture_id: id, ...meta });
          metaById[id] = meta;
        }
      }
      inspected = list.length;
      filtered  = norm.length;
      list = norm.slice(0, 60);
    }

    // Ako i dalje nema kandidata i nije force → nema šta da se radi
    if (!list || !list.length) {
      return res.status(200).json({
        ok: true, ymd, slot,
        inspected, filtered, targeted: 0, touched: 0,
        source: "refresh-odds",
        debug: { tried, pickedKey, listLen: 0, saved_backends: [] }
      });
    }

    // 1) izvuci ID-jeve i paralelno osveži /odds
    const ids = uniqNums(list.map(x => x?.fixture_id ?? x?.fixture?.id ?? x?.id ?? x));
    const lanes = 5;
    const buckets = Array.from({length: lanes}, ()=>[]);
    ids.forEach((x,i)=>buckets[i%lanes].push(x));

    const haveVbl = !!arrFromAny(toObj((await kvGETraw(`vbl:${ymd}:${slot}`)).raw));
    const createdLocked = [];
    let called = 0, cached = 0;

    const lane = async (subset)=>{
      for(const id of subset){
        try{
          const jo = await afFetch("/odds", { fixture: id });
          called++;
          const payload = { fetched_at: Date.now(), fixture_id: id, data: jo?.response ?? jo };
          await kvSETjsonAll(`odds:fixture:${id}`, payload);

          if(!haveVbl){
            const bookmakers = (jo?.response?.[0]?.bookmakers) || [];
            const best = best1x2FromBookmakers(bookmakers);
            const meta = metaById?.[id] || {};
            if(best && inSlotLocal(meta, slot)){
              createdLocked.push({
                fixture_id: id,
                league: meta.league || null,
                league_name: meta?.league?.name || null,
                league_country: meta?.league?.country || null,
                teams: { home: meta?.teams?.home?.name, away: meta?.teams?.away?.name },
                home: meta?.teams?.home?.name || null,
                away: meta?.teams?.away?.name || null,
                datetime_local: meta?.datetime_local || null,
                kickoff_utc: meta?.kickoff_utc || null,
                market: "1X2",
                selection_label: best.pick,
                pick: best.pick,
                pick_code: best.pick_code,
                model_prob: best.model_prob,
                confidence_pct: Math.round(100*best.model_prob),
                odds: { price: best.price, books_count: best.books_count || 1 },
              });
            }
          }
          cached++;
        }catch{}
        await new Promise(r=>setTimeout(r, 120));
      }
    };
    await Promise.all(buckets.map(lane));

    let savedBackends = [];
    if(createdLocked.length){
      createdLocked.sort((a,b)=>
        (b.confidence_pct - a.confidence_pct) ||
        ((Date.parse(a.kickoff_utc||0)) - (Date.parse(b.kickoff_utc||0)))
      );
      const full = createdLocked.slice(0, 60);
      const cut  = createdLocked.slice(0, 15);
      const r1 = await kvSETjsonAll(`vbl_full:${ymd}:${slot}`, full);
      const r2 = await kvSETjsonAll(`vbl:${ymd}:${slot}`,     cut);
      savedBackends = Array.from(new Set([...(r1.backends||[]), ...(r2.backends||[])]));
    }

    return res.status(200).json({
      ok: true,
      ymd, slot,
      inspected,
      filtered,
      targeted: ids.length,
      touched: cached,
      source: "refresh-odds",
      debug: { tried, pickedKey, listLen: (createdLocked||[]).length, saved_backends: savedBackends }
    });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e), source:"refresh-odds" });
  }
}
