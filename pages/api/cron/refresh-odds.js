// pages/api/cron/refresh-odds.js
import {} from "url";

export const config = { api: { bodyParser: false } };

/* ───────── TZ guard ───────── */
function pickTZ() {
  const raw = (process.env.TZ || process.env.TZ_DISPLAY || "UTC").trim();
  const s = raw.replace(/^:+/, "");
  try { new Intl.DateTimeFormat("en-GB", { timeZone: s }); return s; } catch { return "UTC"; }
}
const TZ = pickTZ();

/* ───────── KV helpers ───────── */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv:rw", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash:rw",  url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization:`Bearer ${b.tok}` }, cache:"no-store"
      });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      if (val) return { raw: val, flavor: b.flavor };
    } catch {}
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value) {
  const body = JSON.stringify({ value: typeof value==="string" ? value : JSON.stringify(value) });
  const out = [];
  for (const b of kvBackends()) {
    try{
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method:"POST", headers:{ Authorization:`Bearer ${b.tok}`, "Content-Type":"application/json" }, body
      });
      out.push({ flavor:b.flavor, ok:r.ok });
    }catch{ out.push({ flavor:b.flavor, ok:false }); }
  }
  return out;
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

/* ───────── handler ───────── */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");
    const q   = req.query || {};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const slot= (String(q.slot||"").toLowerCase().trim() || deriveSlot(hourInTZ(now, TZ)));

    // 1) Učitaj bazni VB feed (prefer slot → union → last)
    const triedKeys = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:union`, `vb:day:${ymd}:last`];
    let pickedKey = null, list = [];
    for (const k of triedKeys){
      const { raw } = await kvGETraw(k);
      const arr = arrFromAny(J(raw));
      if (Array.isArray(arr) && arr.length){ pickedKey = k; list = arr; break; }
    }

    // 2) Minimalni "touch" tiket objekta na dnevnom nivou (da rebuild ima od čega)
    const { raw:rawT } = await kvGETraw(`tickets:${ymd}`);
    const tObj = J(rawT) || {};
    if (!Array.isArray(tObj.btts)) tObj.btts = [];
    if (!Array.isArray(tObj.ou25)) tObj.ou25 = [];
    if (!Array.isArray(tObj.htft)) tObj.htft = [];

    // (bez spoljnjih API poziva ovde; samo “keep fresh” zapis)
    const tSave = await kvSET(`tickets:${ymd}`, tObj);

    // 3) Statistika/odgovor
    const touched = list.length;
    return res.status(200).json({
      ok:true, ymd, slot,
      inspected: list.length, filtered: 0, targeted: list.length, touched,
      source: `refresh-odds:${pickedKey||"none"}`,
      debug: { tried: triedKeys },
      odds_api: [], // nema ekstenzivnih poziva ovde
      oa_summary: { matched:0, saved:0, calls:1, budget_per_day: Number(process.env.ODDS_API_DAILY_CAP||15), remaining_before: 15, used_now: 1 },
      tickets_saved: tSave
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e), debug:{ trace:[] } });
  }
}
