// pages/api/value-bets-locked.js
// Uvek vrati 1x2: najpre slot (vbl_full/vbl/vb:day:<slot>), a ako je prazno -> union/last BEZ slot filtra.
// Tikete čita slot->day, sortira i vraća. Bez novih dependencija.

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
  const f = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = f.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const f = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(f.format(d),10);
}
function deriveSlot(h){ if (h<10) return "late"; if (h<15) return "am"; return "pm"; }

function kickoffFromMeta(it){
  const s = it?.kickoff_utc || it?.kickoff || it?.time?.starting_at?.date_time ||
            it?.datetime_local?.starting_at?.date_time || it?.datetime_local?.date_time ||
            it?.fixture?.date || null;
  const d = s ? new Date(s) : null;
  return (d && !isNaN(d)) ? d : null;
}
function inSlotLocal(it, slot){
  const d = kickoffFromMeta(it);
  if (!d) return true; // lax
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}
function notStarted(it){ const d=kickoffFromMeta(it); return d ? (d.getTime() > Date.now()) : true; }

const YOUTH = [/\bU(-|\s)?(17|18|19|20|21|22|23)\b/i, /\bPrimavera\b/i, /\bYouth\b/i];
function isYouthOrBanned(it){
  const ln = (it?.league_name || it?.league?.name || "")+"";
  const h  = (it?.home || it?.teams?.home?.name || "")+"";
  const a  = (it?.away || it?.teams?.away?.name || "")+"";
  return YOUTH.some(rx=>rx.test(`${ln} ${h} ${a}`));
}
function confidence(it){
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob))     return Math.round(100*Number(it.model_prob));
  return 0;
}
function kickoffMs(it){ const d = kickoffFromMeta(it); return d ? d.getTime() : Number.MAX_SAFE_INTEGER; }
function capFor(ymd, slot){
  const d = new Date(`${ymd}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat("en-GB",{ timeZone:TZ, weekday:"short"}).format(d);
  const wknd = (wd==="Sat"||wd==="Sun");
  if (slot==="late") return 6;
  return wknd ? 20 : 15;
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* --------------- tiketi --------------- */
async function readTickets(ymd, slot, trace){
  const tried = [];
  // slot → day
  const slotTry = await kvGETraw(`tickets:${ymd}:${slot}`, tried);
  let obj = toObj(slotTry.raw); let source = slotTry.raw ? `tickets:${ymd}:${slot}` : null;
  if (!obj) {
    const dayTry = await kvGETraw(`tickets:${ymd}`, tried);
    obj = toObj(dayTry.raw);
    if (dayTry.raw) source = source || `tickets:${ymd}`;
  }
  const empty = { btts:[], ou25:[], htft:[] };
  if (!obj || typeof obj!=="object") return { tickets: empty, source: source||null, tried };

  const clean = (arr=[]) => (arr||[])
    .filter(notStarted)
    .filter(it => !isYouthOrBanned(it))
    .filter(it => !it.market_odds || Number(it.market_odds) >= MIN_ODDS)
    .sort((a,b)=> (Number(b?.confidence_pct||0)-Number(a?.confidence_pct||0)) ||
                  (kickoffMs(a)-kickoffMs(b)));
  return { tickets:{
      btts: clean(obj.btts),
      ou25: clean(obj.ou25),
      htft: clean(obj.htft),
    }, source: source||null, tried };
}

/* ---------------- handler ---------------- */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");
    const q = req.query || {};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const slot = (String(q.slot||"").trim().toLowerCase() || deriveSlot(hourInTZ(now, TZ)));
    const wantDebug = String(q.debug||"") === "1" || String(q.debug||"").toLowerCase() === "true";
    const trace = wantDebug ? [] : null;

    const prefer = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      // dnevni fallback izvori:
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
    ];

    // skupi sve što postoji
    let pool = [];
    const sourcesHit = [];
    for (const k of prefer){
      const r = await kvGETraw(k, trace);
      const arr = arrFromAny(toObj(r.raw));
      if (Array.isArray(arr) && arr.length){ pool.push(...arr); sourcesHit.push(k); }
    }

    const beforeAny = pool.length;

    // dedup po fixture_id
    const seen = new Set(); pool = pool.filter(it=>{
      const id = Number(it?.fixture_id ?? it?.id); if (!id) return false;
      if (seen.has(id)) return false; seen.add(id); return true;
    });

    // 1) probaj čisto slot-filter
    let filtered = pool
      .filter(it => inSlotLocal(it, slot))
      .filter(it => !isYouthOrBanned(it))
      .filter(it => !it.odds || Number(it?.odds?.price ?? 0) >= MIN_ODDS);

    // 2) ako je prazno → NO-SLOT FALLBACK (uzmi union/last kakvi jesu)
    let usedNoSlotFallback = false;
    if (!filtered.length && pool.length){
      filtered = pool
        .filter(notStarted)
        .filter(it => !isYouthOrBanned(it))
        .filter(it => !it.odds || Number(it?.odds?.price ?? 0) >= MIN_ODDS);
      usedNoSlotFallback = true;
    }

    // sort (conf desc, kickoff asc) i cap
    filtered.sort((a,b)=> (confidence(b)-confidence(a)) || (kickoffMs(a)-kickoffMs(b)));
    const cap = capFor(ymd, slot);
    const items = filtered.slice(0, cap);
    const top3 = items.slice(0,3);

    // tiketi (slot-first, pa day)
    const { tickets, source:tsrc, tried:ttried } = await readTickets(ymd, slot, trace);

    const payload = {
      ok: true,
      slot, ymd,
      items,
      football: items,
      top3,
      tickets,
      source: sourcesHit.join(" + ") + (usedNoSlotFallback ? " + fallback:noslot" : ""),
      tickets_source: tsrc,
      policy_cap: cap,
    };
    if (wantDebug) payload.debug = { tried: prefer, trace, tickets_tried: ttried, before: beforeAny, after: items.length };
    return res.status(200).json(payload);

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
