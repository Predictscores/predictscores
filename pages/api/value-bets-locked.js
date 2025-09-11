// pages/api/value-bets-locked.js
import { } from 'url'; // placeholder: zadržava ES module sintaksu u Next okruženju

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ---------------- KV (REST) ---------------- */
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
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x==="object"){
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value==="string"){ const v=J(x.value); if (Array.isArray(v)) return v; if (v&&typeof v==="object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
    if (Array.isArray(x.list))  return x.list;
  }
  if (typeof x==="string"){ const v=J(x); if (Array.isArray(v)) return v; if (v&&typeof v==="object") return arrFromAny(v); }
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
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.fixture?.date || null;
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}
function confidence(it){
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob)) return Math.round(100*Number(it.model_prob));
  if (Number.isFinite(it?.implied_prob)) return Math.round(100*Number(it.implied_prob));
  return 0;
}

/* --------------- caps (weekday/weekend) --------------- */
const CAP_LATE   = Math.max(1, Number(process.env.CAP_LATE   || 6)  || 6);
const CAP_AM_WD  = Math.max(1, Number(process.env.CAP_AM_WD  || 15) || 15);
const CAP_PM_WD  = Math.max(1, Number(process.env.CAP_PM_WD  || 15) || 15);
const CAP_AM_WE  = Math.max(1, Number(process.env.CAP_AM_WE  || 20) || 20);
const CAP_PM_WE  = Math.max(1, Number(process.env.CAP_PM_WE  || 20) || 20);

function isWeekendInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, weekday:"short" });
  const w = fmt.format(d).toLowerCase();
  return w.startsWith("sat") || w.startsWith("sun");
}
function slotCapFor(ymd, slot){
  const d = new Date(`${ymd}T12:00:00Z`); // neutral
  const weekend = isWeekendInTZ(d, TZ);
  if (slot==="late") return CAP_LATE;
  if (slot==="am")   return weekend ? CAP_AM_WE : CAP_AM_WD;
  return weekend ? CAP_PM_WE : CAP_PM_WD; // pm
}

/* ---------------- items (1X2) reader ---------------- */
async function readItems(ymd, slot, trace){
  const policyCap = 15; // UI policy cap; real cap će biti min(slotCap, policyCap)

  function inSlot(d){
    const h = hourInTZ(d, TZ);
    return (slot==="late"? h<10 : slot==="am"? (h>=10 && h<15) : h>=15);
  }

  const strictKeys = [
    `vbl_full:${ymd}:${slot}`,
    `vbl:${ymd}:${slot}`,
    `vb:day:${ymd}:${slot}`,
  ];
  for (const k of strictKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      // dodatni filter po slotu — iako je feed "locked"
      const only = arr.filter(it => {
        const d = kickoffFromMeta(it); return d ? inSlot(d) : true;
      });
      const slotCap = slotCapFor(ymd, slot);
      const cut = [...only]
        .sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)))
        .slice(0, Math.min(policyCap, slotCap));
      return { items: cut, source: k, before: arr.length, after: cut.length, slotCap, policyCap };
    }
  }

  // fallback: UNION/LAST (bez slot filtera), pa opet sečemo na slotCap
  const fallbackKeys = [`vb:day:${ymd}:union`, `vb:day:${ymd}:last`];
  for (const k of fallbackKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const slotCap = slotCapFor(ymd, slot);
      const list = [...arr]
        .sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)))
        .slice(0, Math.min(policyCap, slotCap));
      return { items: list, source: k, before: arr.length, after: list.length, slotCap, policyCap };
    }
  }
  const slotCap = slotCapFor(ymd, slot);
  return { items: [], source: null, before: 0, after: 0, slotCap, policyCap };
}

/* ---------------- tickets reader ---------------- */
async function readTickets(ymd, slot, trace){
  const tried = [];
  const now = Date.now();
  const keep = (x)=> {
    const t = kickoffFromMeta(x)?.getTime() || 0;
    return t > now; // samo mečevi koji još nisu počeli
  };
  const sortT = (a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0));

  const slotKey = `tickets:${ymd}:${slot}`;
  const { raw:rawSlot } = await kvGETraw(slotKey, tried);
  let obj = J(rawSlot);
  let src = obj ? slotKey : null;

  if (!obj || typeof obj !== "object") {
    const dayKey = `tickets:${ymd}`;
    const { raw:rawDay } = await kvGETraw(dayKey, tried);
    obj = J(rawDay);
    if (obj) src = dayKey;
  }
  if (!obj) return { tickets:{ btts:[], ou25:[], htft:[] }, source: src, tried };

  return {
    tickets: {
      btts: (obj.btts||[]).filter(keep).sort(sortT),
      ou25: (obj.ou25||[]).filter(keep).sort(sortT),
      htft: (obj.htft||[]).filter(keep).sort(sortT),
    },
    source: src,
    tried
  };
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

    const { items, source, before, after, slotCap, policyCap } = await readItems(ymd, slot, trace);
    const { tickets, source:tsrc, tried:ttried } = await readTickets(ymd, slot, trace);

    const payload = {
      ok: true,
      slot,
      ymd,
      items,
      football: items,
      top3: items.slice(0,3),
      tickets,
      source,
      tickets_source: tsrc,
      policy_cap: policyCap,
      slot_cap: slotCap,
      ...(wantDebug ? { debug:{ trace, before, after, tickets_tried:ttried } } : {})
    };
    return res.status(200).json(payload);
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
