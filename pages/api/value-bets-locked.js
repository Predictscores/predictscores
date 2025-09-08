// pages/api/value-bets-locked.js
// Response za UI ("football" tab) sa tvrdim cap-om po slotu i danu u nedelji.
// Weekday: late=6, am=15, pm=15;  Weekend (Sat/Sun): late=6, am=20, pm=20.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";
const MIN_ODDS = 1.5;

/* ---------------- KV helpers ---------------- */
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
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store",
      });
      const ok = r.ok;
      const j = ok ? await r.json().catch(()=>null) : null;
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      trace && trace.push({ key, flavor:b.flavor, status: ok ? (val?"hit":"miss") : `http-${r.status}` });
      if (val) return { raw: val, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ key, flavor:b.flavor, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------------- utils ---------------- */
function toObj(s){ if(!s) return null; try{ return JSON.parse(s); }catch{ return null; } }
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.items)) return x.items;
  if (Array.isArray(x?.football)) return x.football;
  if (Array.isArray(x?.value_bets)) return x.value_bets;
  if (Array.isArray(x?.list)) return x.list;
  if (Array.isArray(x?.data)) return x.data;
  if (x && typeof x === "object" && typeof x.value === "string") {
    try { const v = JSON.parse(x.value); if (Array.isArray(v)) return v; } catch {}
  }
  return null;
}
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

function kickoffFromMeta(it){
  const s =
    it?.kickoff_utc ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.fixture?.date || null;
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function inSlotLocal(it, slot){
  const d = kickoffFromMeta(it);
  if (!d) return true; // lax: ako nema vremena, nemoj ga izbaciti
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}

const YOUTH_PATTERNS = [
  /\bU(-|\s)?(17|18|19|20|21|22|23)\b/i,
  /\bPrimavera\b/i,
  /\bYouth\b/i,
];
function isYouthOrBanned(it){
  const ln = (it?.league_name || it?.league?.name || "").toString();
  const h = (it?.home || it?.teams?.home?.name || "").toString();
  const a = (it?.away || it?.teams?.away?.name || "").toString();
  const s = `${ln} ${h} ${a}`;
  return YOUTH_PATTERNS.some(rx => rx.test(s));
}

function dedupByFixture(arr) {
  const seen = new Set(); const out = [];
  for (const it of arr||[]) {
    const id = Number(it?.fixture_id ?? it?.fixture?.id ?? it?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(it);
  }
  return out;
}
function confidence(it){
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob)) return Math.round(100*Number(it.model_prob));
  return 0;
}
function kickoffMs(it){
  const d = kickoffFromMeta(it);
  return d ? d.getTime() : Number.MAX_SAFE_INTEGER;
}

function capFor(ymd, slot){
  // weekend detection in TZ
  const d = new Date(`${ymd}T12:00:00Z`); // neutral UTC noon
  const dow = new Intl.DateTimeFormat("en-GB",{ timeZone:TZ, weekday:"short"}).format(d); // e.g., Mon..Sun
  const isWeekend = (dow === "Sat" || dow === "Sun");
  if (slot === "late") return 6;
  if (isWeekend) return 20;
  return 15;
}

/* ---------------- handler ---------------- */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");

    const q = req.query || {};
    const now = new Date();
    const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(late|am|pm)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
    const wantDebug = String(q.debug ?? "") === "1";
    const trace = wantDebug ? [] : null;

    // 1) pokupi kandidate iz više izvora (vbl_full, vbl, vb:day:<slot>)
    const triedKeys = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
    ];
    let pool = [];
    let source = [];
    for (const k of triedKeys) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(toObj(raw));
      if (Array.isArray(arr) && arr.length) {
        pool.push(...arr);
        source.push(k);
      }
    }
    pool = dedupByFixture(pool);

    // Ako nema ničega, vrati prazan odgovor (ne diramo dalje logike)
    if (!pool.length) {
      return res.status(200).json({
        ok:true, slot, ymd, items:[], football:[], top3:[],
        source: source.length ? source.join(" + ") : null,
        policy_cap: capFor(ymd, slot),
        ...(wantDebug ? { debug:{ tried: triedKeys, trace } } : {})
      });
    }

    // 2) filtriraj slot + ban + min odds
    pool = pool
      .filter(it => inSlotLocal(it, slot))
      .filter(it => !isYouthOrBanned(it))
      .filter(it => !it.odds || Number(it?.odds?.price ?? 0) >= MIN_ODDS);

    // 3) sort: confidence desc, pa kickoff asc
    pool.sort((a,b)=>
      (confidence(b) - confidence(a)) ||
      (kickoffMs(a) - kickoffMs(b))
    );

    // 4) cap po slotu i danu
    const cap = capFor(ymd, slot);
    const items = pool.slice(0, cap);

    // 5) izlaz u formatu koji UI očekuje
    const top3 = items.slice(0,3);
    const payload = {
      ok: true,
      slot,
      ymd,
      items,
      football: items,   // isti set za "football" tab
      top3,
      source: source.join(" + "),
      policy_cap: cap,
    };
    if (wantDebug) payload.debug = { tried: triedKeys, trace, before: pool.length, after: items.length };
    return res.status(200).json(payload);

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
