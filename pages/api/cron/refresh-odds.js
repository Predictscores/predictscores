// pages/api/cron/refresh-odds.js
// Osvežava kvote; ako vbl* ne postoji, generiše vbl_full:/vbl: za slot.
// NOVO: usaglašeni slotovi (late 00–09, am 10–14, pm 15–23) + slot-filter pre kreiranja vbl/vbl_full.
// NOVO: upisuje u SVE dostupne KV backend-e (Vercel KV i/ili Upstash).
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
async function kvGETraw(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store",
      });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      if (typeof j?.result === "string" && j.result) {
        return { raw: j.result, flavor: b.flavor };
      }
    } catch { /* next backend */ }
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
        // Upstash Redis REST pipeline
        const r = await fetch(`${b.url}/pipeline`, {
          method: "POST",
          headers: { Authorization: `Bearer ${b.tok}`, "content-type":"application/json" },
          body: JSON.stringify([{ command: "SET", args: [key, val] }]),
        });
        if (r.ok) saved.push(b.flavor);
      }
    } catch { /* ignore one backend */ }
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
// USKLAĐENO sa ostatkom sistema:
function deriveSlot(h){ if(h<10) return "late"; if(h<15) return "am"; return "pm"; }

/* --------------- slot helpers --------------- */
function kickoffFromMeta(meta){
  const s = meta?.kickoff_utc || meta?.datetime_local?.starting_at?.date_time || null;
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function inSlotLocal(meta, slot){
  const d = kickoffFromMeta(meta);
  if (!d) return true; // ako ne znamo vreme, ne odbacuj
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
  const qs = new URLSearchParams(params).toString();
  const url = `${AF_BASE}${path}${qs?`?${qs}`:""}`;
  const r = await fetch(url,{ headers:{ "x-apisports-key": key }, cache:"no-store" });
  const ct = r.headers.get("content-type")||"";
  if(!r.ok) throw new Error(`AF ${path} ${r.status}`);
  if(ct.includes("application/json")) return await r.json();
  const t = await r.text(); try{ return JSON.parse(t); }catch{ throw new Error(`AF non-json ${path}`); }
}

/* --------------- seed & odds --------------- */
function uniqNums(a){ const s=new Set(); for(const v of a||[]){ const n=Number(v); if(Number.isFinite(n)&&n>0)s.add(n);} return [...s]; }

function best1x2FromBookmakers(bookmakers){
  let best = null; let books = 0;
  for(const b of bookmakers||[]){
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
  if(best) best.books_count = books;
  return best;
}

async function collectFixtureIdsAndMeta(ymd, slot){
  // 1) KV (vbl/vb:day…)
  const keys = [
    `vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`,
    `vb:day:${ymd}:${slot}`, `vb:day:${ymd}:last`, `vb:day:${ymd}:union`
  ];
  for(const k of keys){
    const arr = arrFromAny(toObj((await kvGETraw(k)).raw));
    if(arr && arr.length){
      const ids = uniqNums(arr.map(x=>x?.fixture_id ?? x?.fixture?.id));
      if(ids.length) return { ids, source:`kv:${k}`, metaById: Object.fromEntries(arr.map(x=>{
        const id = Number(x?.fixture_id ?? x?.fixture?.id); return [id, x];
      })) };
    }
  }
  // 2) Seed: fixtures od dana
  const jf = await afFetch("/fixtures", { date: ymd, timezone: TZ });
  const resp = Array.isArray(jf?.response) ? jf.response : [];
  // stabilno sortiranje po vremenu
  resp.sort((a,b)=> new Date(a?.fixture?.date||0) - new Date(b?.fixture?.date||0));
  const ids = uniqNums(resp.map(x=>x?.fixture?.id));
  const metaById = {};
  for(const it of resp){
    const id = Number(it?.fixture?.id);
    if(!id) continue;
    metaById[id] = {
      league: it?.league,
      teams: it?.teams,
      datetime_local: { starting_at: { date_time: it?.fixture?.date?.replace("T"," ").replace("Z","") } },
      kickoff_utc: it?.fixture?.date || null,
    };
  }
  return { ids: ids.slice(0,60), source:"seed:fixtures:date", metaById };
}

/* ------------------- handler ------------------- */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");

    const q = req.query||{};
    const now = new Date();
    const ymd = (q.ymd && String(q.ymd).match(/^\d{4}-\d{2}-\d{2}$/)) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(q.slot)) ? q.slot : deriveSlot(hourInTZ(now, TZ));
    const force = String(q.force ?? "0")==="1";

    if(!getAFKey()) {
      return res.status(200).json({ ok:false, ymd, slot, error:"API-Football key missing", source:"refresh-odds" });
    }

    // 1) fixture ID-evi + meta
    let { ids, source, metaById } = await collectFixtureIdsAndMeta(ymd, slot);
    if((!ids || !ids.length) && !force){
      return res.status(200).json({ ok:true, ymd, slot, inspected:0, filtered:0, targeted:0, touched:0, source:"refresh-odds:empty-no-force", debug:{ tried:[] } });
    }

    // 2) SLOT FILTER pre kreiranja vbl/vbl_full
    const rows = (ids||[]).map(id => ({ id, meta: metaById?.[id] })).filter(r=>r && r.id);
    const slotRows = rows.filter(r => inSlotLocal(r.meta, slot));
    const picked = (slotRows.length ? slotRows : rows).slice(0, 60).map(r=>r.id);

    // 3) povuci odds; ako vbl* ne postoji, napravi locked listu (samo za picked)
    const haveVbl = !!arrFromAny(toObj((await kvGETraw(`vbl:${ymd}:${slot}`)).raw));
    const createdLocked = [];
    let called = 0, cached = 0;

    // blaga paralelizacija
    const lanes = 5;
    const buckets = Array.from({length: lanes}, ()=>[]);
    picked.forEach((x,i)=>buckets[i%lanes].push(x));

    const lane = async (subset)=>{
      for(const id of subset){
        try{
          const jo = await afFetch("/odds", { fixture: id });
          called++;
          const payload = { fetched_at: Date.now(), fixture_id: id, data: jo?.response ?? jo };
          // cache odds u sve KV-e (nije presudno, ali uniformno)
          await kvSETjsonAll(`odds:fixture:${id}`, payload);

          if(!haveVbl){
            const bookmakers = (jo?.response?.[0]?.bookmakers) || [];
            const best = best1x2FromBookmakers(bookmakers);
            const meta = metaById?.[id] || {};
            // dodatni gard: ako meta postoji, proveri slot
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
          cached++; // broj uspešnih fetch+obrada
        }catch{ /* skip one id */ }
        await new Promise(r=>setTimeout(r, 120));
      }
    };
    await Promise.all(buckets.map(lane));

    // 4) ako smo kreirali locked listu → upiši u SVE backend-e
    let savedBackends = [];
    if(createdLocked.length){
      createdLocked.sort((a,b)=>
        (b.confidence_pct - a.confidence_pct) ||
        ((Date.parse(a.kickoff_utc||0)) - (Date.parse(b.kickoff_utc||0)))
      );
      const full = createdLocked.slice(0, 25);
      const cut  = createdLocked.slice(0, 15);
      const r1 = await kvSETjsonAll(`vbl_full:${ymd}:${slot}`, full);
      const r2 = await kvSETjsonAll(`vbl:${ymd}:${slot}`, cut);
      savedBackends = Array.from(new Set([...(r1.backends||[]), ...(r2.backends||[])]));
    }

    return res.status(200).json({
      ok: true,
      ymd, slot,
      inspected: ids.length,
      filtered: slotRows.length,
      targeted: picked.length,
      touched: cached,
      source: `refresh-odds:per-fixture`,
      debug: {
        tried: [`${source}`],
        pickedKey: createdLocked.length?`vbl:${ymd}:${slot}`:null,
        listLen: createdLocked.length,
        saved_backends: savedBackends
      }
    });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e), source:"refresh-odds" });
  }
}
