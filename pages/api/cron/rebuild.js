// pages/api/cron/rebuild.js
// Rekonstrukcija "locked" feed-a za slot (late 00–09, am 10–14, pm 15–23).
// 1) Učita kandidate iz KV (vb:day → vbl_full → vbl) ili fallback-uje na fixtures za dan.
// 2) Strogo filtrira po slotu.
// 3) **NOVO:** Za već filtrirane fixture-ove povuče /odds i popuni pick/odds/confidence.
// 4) Upisuje u vb:day:<YMD>:<slot> (+union,+last) i MIRROR u vbl_full:<YMD>:<slot> i vbl:<YMD>:<slot>.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ---------------- KV (Vercel REST) ---------------- */
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
      const ok = r.ok;
      const j  = ok ? await r.json().catch(() => null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || [], diag.reads.push({ flavor:c.flavor, key, status: ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` }));
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || [], diag.reads.push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` }));
    }
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, valueString, diag) {
  let saved = [];
  for (const c of kvCfgs().filter(x => x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ value: valueString }),
      });
      if (r.ok) saved.push(c.flavor);
      diag && (diag.writes = diag.writes || [], diag.writes.push({ flavor:c.flavor, key, status:r.ok ? "ok" : `http-${r.status}` }));
    } catch (e) {
      diag && (diag.writes = diag.writes || [], diag.writes.push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` }));
    }
  }
  return saved;
}

/* ---------------- parse helpers ---------------- */
function J(s){ try{ return JSON.parse(s); }catch{ return null; } }
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.value_bets)) return x.value_bets;
    if (Array.isArray(x.football)) return x.football;
    if (Array.isArray(x.list)) return x.list;
    if (Array.isArray(x.data)) return x.data;
  }
  return null;
}
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v1 = J(raw);
  if (Array.isArray(v1)) return v1;
  if (v1 && typeof v1 === "object" && "value" in v1) {
    if (Array.isArray(v1.value)) return v1.value;
    if (typeof v1.value === "string") {
      const v2 = J(v1.value);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") return arrFromAny(v2);
    }
    return null;
  }
  if (v1 && typeof v1 === "object") return arrFromAny(v1);
  return null;
}

/* ---------------- time + slot helpers ---------------- */
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
function kickoffDate(x){
  const ts = x?.fixture?.timestamp ?? x?.timestamp;
  if (typeof ts === "number" && isFinite(ts)) {
    const d = new Date(ts * 1000);
    if (!isNaN(d.getTime())) return d;
  }
  const s =
    x?.kickoff_utc ||
    x?.datetime_local?.starting_at?.date_time ||
    x?.fixture?.date ||
    x?.datetime_utc ||
    x?.start_time?.utc ||
    x?.start_time;
  if (!s || typeof s !== "string") return null;
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}
function inSlotLocal(item, slot) {
  const d = kickoffDate(item);
  if (!d) return false;  // strogo: bez vremena ne prolazi
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}

/* ---------------- API-Football ---------------- */
const AF_BASE = "https://v3.football.api-sports.io";
function afKey(){ return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || ""; }
async function afFetch(path, params={}){
  const key = afKey();
  if (!key) throw new Error("Missing API-Football key");
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers:{ "x-apisports-key": key }, cache:"no-store" });
  const ct = r.headers.get("content-type")||"";
  const t = await r.text();
  if (!ct.includes("application/json")) throw new Error(`AF non-JSON ${r.status}: ${t.slice(0,120)}`);
  let j; try{ j=JSON.parse(t);}catch{ j=null; }
  if (!j) throw new Error("AF parse error");
  return j;
}
function mapFixtureToItem(fx){
  const id = Number(fx?.fixture?.id);
  const kick = fx?.fixture?.date || null;
  const ts   = fx?.fixture?.timestamp || null;
  const teams = { home: fx?.teams?.home?.name || null, away: fx?.teams?.away?.name || null };
  const league = fx?.league || null;
  return {
    fixture_id: id,
    league,
    league_name: league?.name || null,
    league_country: league?.country || null,
    teams,
    home: teams.home,
    away: teams.away,
    datetime_local: kick ? { starting_at: { date_time: String(kick).replace("T"," ").replace("Z","") } } : null,
    kickoff_utc: kick,
    timestamp: ts,
    // stub polja; popunićemo posle sa /odds
    market: "1X2",
    selection_label: null,
    pick: null,
    pick_code: null,
    model_prob: null,
    confidence_pct: null,
    odds: null,
    fixture: { id, timestamp: ts, date: kick },
  };
}

/* -------- pick/odds helpers (novo) -------- */
function best1x2FromBookmakers(bookmakers){
  let best = null, books = 0;
  for(const b of bookmakers || []){
    books++;
    for(const bet of b.bets || []){
      const name = String(bet.name||"").toLowerCase();
      if(!(name.includes("match winner") || name==="1x2" || name.includes("winner"))) continue;
      const vals = bet.values || [];
      const vHome = vals.find(v=>/^home$/i.test(v.value||""));
      const vDraw = vals.find(v=>/^draw$/i.test(v.value||""));
      const vAway = vals.find(v=>/^away$/i.test(v.value||""));
      if(!(vHome && vDraw && vAway)) continue;
      const oH = parseFloat(vHome.odd), oD = parseFloat(vDraw.odd), oA = parseFloat(vAway.odd);
      if(!isFinite(oH)||!isFinite(oD)||!isFinite(oA)) continue;
      const pH = 1/oH, pD = 1/oD, pA = 1/oA, S = pH+pD+pA;
      const cand = [
        {code:"1", label:"Home", prob:pH/S, price:oH},
        {code:"X", label:"Draw", prob:pD/S, price:oD},
        {code:"2", label:"Away", prob:pA/S, price:oA},
      ].sort((a,b)=>b.prob-a.prob)[0];
      if(!best || cand.prob>best.model_prob || (Math.abs(cand.prob-best.model_prob)<1e-9 && cand.price<best.odds.price)){
        best = { pick_code:cand.code, pick:cand.label, model_prob:cand.prob, odds:{ price:cand.price } };
      }
    }
  }
  if(best) best.odds.books_count = books;
  return best;
}

async function enrichWithOdds(items){
  const ids = items.map(x=>Number(x.fixture_id)).filter(n=>Number.isFinite(n));
  const lanes = 4;
  const buckets = Array.from({length: lanes}, ()=>[]);
  ids.forEach((id,i)=> buckets[i%lanes].push(id));

  const byId = new Map(items.map(it=>[Number(it.fixture_id), it]));
  let called = 0, filled = 0;

  const lane = async subset=>{
    for(const id of subset){
      try{
        const jo = await afFetch("/odds", { fixture: id });
        called++;
        const bookmakers = jo?.response?.[0]?.bookmakers || [];
        const best = best1x2FromBookmakers(bookmakers);
        if(best){
          const it = byId.get(id);
          if(it){
            it.selection_label = best.pick;
            it.pick = best.pick;
            it.pick_code = best.pick_code || best.pick_code || (best.pick === "Home" ? "1" : best.pick === "Draw" ? "X" : "2");
            it.model_prob = best.model_prob;
            it.confidence_pct = Math.round(100*best.model_prob);
            it.odds = { price: best.odds.price, books_count: best.odds.books_count || best.books_count || 1 };
            filled++;
          }
        }
      }catch{/* skip one */}
      await new Promise(r=>setTimeout(r, 120));
    }
  };
  await Promise.all(buckets.map(lane));
  return { called, filled };
}

/* ---------------- main ---------------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const now = new Date();
  const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
  const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
  const wantDebug = String(q.debug ?? "") === "1";
  const diag = wantDebug ? {} : null;

  try {
    // 1) Učitaj iz KV
    const prefer = [
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
    ];
    let rawArr = null, src = null;
    for (const k of prefer) {
      const { raw } = await kvGET(k, diag);
      const arr = arrFromAny(unpack(raw));
      if (arr && arr.length) { rawArr = arr; src = k; break; }
    }

    // 2) Ako nema ništa → fixtures za dan
    let items = null;
    if (rawArr && rawArr.length) {
      const looksLikeIdsOnly = rawArr.every(v =>
        typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ||
        (v && typeof v === "object" && v.fixture_id == null && v.fixture?.id == null && v.kickoff_utc == null)
      );
      if (looksLikeIdsOnly) {
        // ako je vbl lista ID-jeva, dovuci pune fixture objekte
        const ids = Array.from(new Set(rawArr.map(v => Number(v)).filter(Number.isFinite))).slice(0, 60);
        const got = [];
        for (const id of ids) {
          try {
            const jf = await afFetch("/fixtures", { id });
            const fx = Array.isArray(jf?.response) ? jf.response[0] : null;
            if (fx) got.push(mapFixtureToItem(fx));
          } catch {}
          await new Promise(r=>setTimeout(r,120));
        }
        items = got;
        src = `${src}→af:fixtures[id]`;
      } else {
        items = rawArr;
      }
    } else {
      const jf = await afFetch("/fixtures", { date: ymd, timezone: TZ });
      const resp = Array.isArray(jf?.response) ? jf.response : [];
      items = resp.map(mapFixtureToItem);
      src = "fallback:af-fixtures";
    }

    // 3) Slot-filter (strogo) i sort
    const filtered = items
      .filter(x => inSlotLocal(x, slot))
      .sort((a,b)=> (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0)))
      .slice(0, 60);

    // 4) **ENRICH ODDS for filtered only** (malo poziva)
    const { called, filled } = await enrichWithOdds(filtered);

    // 5) Upis u vb:day:* (box format) + MIRROR u vbl* (plain array)
    const boxed = JSON.stringify({ value: JSON.stringify(filtered) });
    const kSlot   = `vb:day:${ymd}:${slot}`;
    const kUnion  = `vb:day:${ymd}:union`;
    const kLast   = `vb:day:${ymd}:last`;
    const s1 = await kvSET(kSlot,  boxed, diag);
    const s2 = await kvSET(kUnion, boxed, diag);
    const s3 = await kvSET(kLast,  boxed, diag);

    const vblFull = JSON.stringify(filtered.slice(0, 60));
    const vblCut  = JSON.stringify(filtered.slice(0, 25));
    const s4 = await kvSET(`vbl_full:${ymd}:${slot}`, vblFull, diag);
    const s5 = await kvSET(`vbl:${ymd}:${slot}`,      vblCut,  diag);

    const after = filtered.length;
    return res.status(200).json({
      ok: true,
      ymd,
      mutated: true,
      counts: { union: after, last: after, combined: after },
      source: src,
      saved_backends: Array.from(new Set([...(s1||[]), ...(s2||[]), ...(s3||[]), ...(s4||[]), ...(s5||[])])),
      ...(wantDebug ? { debug: { after, slot, odds_called: called, odds_filled: filled } } : {})
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
