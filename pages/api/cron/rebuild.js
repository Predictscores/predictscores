// pages/api/cron/rebuild.js
import {} from "url";

export const config = { api: { bodyParser: false } };

/* ───────── TZ guard (radi sa TZ_DISPLAY, izbacuje eventualne ":" i validira) ───────── */
function pickTZ() {
  const raw = (process.env.TZ || process.env.TZ_DISPLAY || "UTC").trim();
  const s = raw.replace(/^:+/, ""); // npr ":UTC" -> "UTC"
  try { new Intl.DateTimeFormat("en-GB", { timeZone: s }); return s; } catch { return "UTC"; }
}
const TZ = pickTZ();

/* ───────── KV helpers (Vercel KV i/ili Upstash REST) ───────── */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv:rw", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash:rw",  url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key) {
  const tried = [];
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store",
      });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(()=>null) : null;
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      tried.push({ key, flavor:b.flavor.replace(":rw", ""), status: ok ? (val?"hit":"miss") : `http-${r.status}` });
      if (val) return { raw: val, tried };
    } catch(e) {
      tried.push({ key, flavor:b.flavor.replace(":rw",""), status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw:null, tried };
}
async function kvSET(key, value) {
  const results = [];
  const body = JSON.stringify({ value: typeof value==="string" ? value : JSON.stringify(value) });
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method:"POST", headers:{ Authorization:`Bearer ${b.tok}`, "Content-Type":"application/json" }, body
      });
      results.push({ key, flavor:b.flavor, ok:r.ok });
    } catch { results.push({ key, flavor:b.flavor, ok:false }); }
  }
  return results;
}

/* ───────── utils ───────── */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object"){
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
    if (Array.isArray(x.list))  return x.list;
    if (typeof x.value === "string") return arrFromAny(J(x.value));
    if (Array.isArray(x.value)) return x.value;
  }
  if (typeof x === "string") return arrFromAny(J(x));
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
  const s = it?.kickoff_utc || it?.kickoff || it?.fixture?.date || it?.datetime_local?.starting_at?.date_time || null;
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}
function confidence(it){
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob))     return Math.round(100*Number(it.model_prob));
  return 0;
}
function isWeekend(tz=TZ){
  const wd = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, weekday:"short" }).format(new Date());
  return wd==="Sat" || wd==="Sun";
}
function slotCap(slot, tz=TZ){
  const we = isWeekend(tz);
  const capLate = Number(process.env.CAP_LATE || 6) || 6;
  const capAmWd  = Number(process.env.CAP_AM_WD || 15) || 15;
  const capPmWd  = Number(process.env.CAP_PM_WD || 15) || 15;
  const capAmWe  = Number(process.env.CAP_AM_WE || 20) || 20;
  const capPmWe  = Number(process.env.CAP_PM_WE || 20) || 20;
  if (slot==="late") return capLate;
  if (slot==="am")   return we ? capAmWe : capAmWd;
  return we ? capPmWe : capPmWd;
}

/* ───────── handler ───────── */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");
    const q   = req.query || {};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const slot= (String(q.slot||"").toLowerCase().trim() || deriveSlot(hourInTZ(now, TZ)));
    const cap = slotCap(slot, TZ);

    // 1) Izvor feed-a (prefer per-slot → union → last)
    const tried = [];
    async function firstHit(keys){
      for (const k of keys){
        const { raw, tried: t } = await kvGETraw(k);
        tried.push(...(t||[]));
        const arr = arrFromAny(J(raw));
        if (Array.isArray(arr) && arr.length) return { key:k, arr };
      }
      return { key:null, arr:[] };
    }

    const { key:srcKey, arr:base } = await firstHit([
      `vb:day:${ymd}:${slot}`, `vb:day:${ymd}:union`, `vb:day:${ymd}:last`
    ]);

    // 2) Slot filter + sortiranje
    const only = base.filter(it => {
      const d = kickoffFromMeta(it); if (!d) return false;
      const h = hourInTZ(d, TZ);
      return slot==="late" ? h<10 : slot==="am" ? (h>=10 && h<15) : h>=15;
    }).sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));

    // 3) Cap
    const kept = only.slice(0, cap);

    // 4) Snimi "locked" feed za slot
    const saves = [];
    saves.push(...await kvSET(`vbl:${ymd}:${slot}`, kept));
    saves.push(...await kvSET(`vbl_full:${ymd}:${slot}`, kept));

    // 5) Tickets: učitaj dnevne → filtriraj buduće → snimi per-slot
    const { raw:rawT } = await kvGETraw(`tickets:${ymd}`);
    const tObj = J(rawT) || {};
    const nowTs = now.getTime();
    const keepFuture = list => (Array.isArray(list)? list.filter(x => (kickoffFromMeta(x)?.getTime()||0) > nowTs) : []);

    const tPerSlot = {
      btts: keepFuture(tObj.btts).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
      ou25: keepFuture(tObj.ou25).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
      htft: keepFuture(tObj.htft).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
    };
    const tSave = await kvSET(`tickets:${ymd}:${slot}`, tPerSlot);

    // 6) Odgovor
    return res.status(200).json({
      ok:true, ymd, slot,
      counts: { base: base.length, after_filters: only.length },
      source: srcKey, diag:{ reads: tried, writes:[...saves, ...tSave] },
      vbl: { kept: kept.length, returned: kept.length, tickets: {
        slot_btts: tPerSlot.btts.length, slot_ou25: tPerSlot.ou25.length, slot_htft: tPerSlot.htft.length
      } }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
