// pages/api/value-bets-locked.js
import { } from 'url'; // placeholder da zadrži ES module sintaksu

export const config = { api: { bodyParser: false } };

/* ───────── TZ guard (Vercel: TZ je rezervisan; koristimo TZ_DISPLAY i sanitizujemo) ───────── */
function pickTZ() {
  const raw = (process.env.TZ || process.env.TZ_DISPLAY || "UTC").trim();
  const s = raw.replace(/^:+/, ""); // npr. ":UTC" -> "UTC"
  try { new Intl.DateTimeFormat("en-GB", { timeZone: s }); return s; } catch { return "UTC"; }
}
const TZ = pickTZ();

/* ---------------- KV (REST) ---------------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key, traceArr) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store",
      });
      const ok = r.ok;
      const j = ok ? await r.json().catch(()=>null) : null;
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      traceArr && traceArr.push({ key, flavor:b.flavor, status: ok ? (val?"hit":"miss") : `http-${r.status}` });
      if (val) return { raw: val, flavor: b.flavor };
    } catch (e) {
      traceArr && traceArr.push({ key, flavor:b.flavor, status:`err:${String(e?.message||e)}` });
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
function normMarket(raw){
  const s = String(raw||"").toLowerCase();
  if (s.includes("btts") || s.includes("both teams to score")) return "BTTS";
  if (s.includes("ht/ft") || s.includes("ht-ft") || s.includes("half time/full time")) return "HT-FT";
  if (s.includes("over 2.5") || s.includes("under 2.5") || s.includes("ou2.5") || s.includes("o/u 2.5") || s.includes("totals")) return "O/U 2.5";
  if (s === "1x2" || s.includes("match result") || s.includes("full time result")) return "1X2";
  return (s||"").trim() ? s.toUpperCase() : "1X2";
}

/* ---------------- items (1X2) reader ---------------- */
async function readItems(ymd, slot, trace, capOverride){
  // 0) uzmi “locked” ako postoji
  const lockedKeys = [
    `vbl_full:${ymd}:${slot}`,
    `vbl:${ymd}:${slot}`,
  ];
  for (const k of lockedKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const limited = capOverride ? arr.slice(0, capOverride) : arr;
      return { items: limited, source: k, before: arr.length, after: limited.length };
    }
  }

  // 1) per-slot “vb:day”
  const strictKeys = [ `vb:day:${ymd}:${slot}` ];
  for (const k of strictKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const only = arr.filter(it => {
        const d = kickoffFromMeta(it); if (!d) return false;
        const h = hourInTZ(d, TZ);
        return (slot==="late"? h<10 : slot==="am"? (h>=10 && h<15) : h>=15);
      });
      if (only.length) {
        only.sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));
        const limited = capOverride ? only.slice(0, capOverride) : only;
        return { items: limited, source: k, before: arr.length, after: limited.length };
      }
    }
  }

  // 2) fallback UNION/LAST bez slot filtera
  const fallbackKeys = [`vb:day:${ymd}:union`, `vb:day:${ymd}:last`];
  for (const k of fallbackKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const list = [...arr].sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));
      const cap = capOverride || slotCap(slot, TZ);
      const cut = list.slice(0, cap);
      return { items: cut, source: k, before: arr.length, after: cut.length };
    }
  }
  return { items: [], source: null, before: 0, after: 0 };
}

/* ---------------- tickets reader (zamrznuti, bez future filtera) ---------------- */
function splitMarkets(list){
  const out = { btts:[], ou25:[], htft:[] };
  for (const it of list||[]){
    const m = normMarket(it?.market_label || it?.market);
    if (m==="BTTS") out.btts.push(it);
    else if (m==="O/U 2.5") out.ou25.push(it);
    else if (m==="HT-FT") out.htft.push(it);
  }
  const sortT = (a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0));
  out.btts.sort(sortT); out.ou25.sort(sortT); out.htft.sort(sortT);
  return out;
}
async function readTickets(ymd, slot, trace){
  const tried = [];

  // prioritet: per-slot → “mm” alias → dnevni
  const keys = [
    `tickets:${ymd}:${slot}`,
    `tickets:${ymd}:mm`,
    `tickets:${ymd}`,
  ];
  for (const k of keys){
    const { raw } = await kvGETraw(k, tried);
    const obj = J(raw);
    if (obj && typeof obj === "object") {
      const btts = Array.isArray(obj.btts) ? obj.btts.slice() : [];
      const ou25 = Array.isArray(obj.ou25) ? obj.ou25.slice() : [];
      const htft = Array.isArray(obj.htft) ? obj.htft.slice() : [];
      const any = (btts.length + ou25.length + htft.length) > 0;
      if (any){
        const sorted = splitMarkets([...btts, ...ou25, ...htft]);
        return { tickets: sorted, source: k, tried };
      }
    }
  }
  // nema u KV → deriviraj iz items (caller prosleđuje items)
  return { tickets:null, source:null, tried };
}

/* ---------------- handler ---------------- */
export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");
    const q = req.query || {};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const qsSlot = String(q.slot||"").trim().toLowerCase();
    const slot = /^(am|pm|late)$/.test(qsSlot) ? qsSlot : deriveSlot(hourInTZ(now, TZ));

    // ?n= ograničenje za 1X2 listu; ne utiče na tikete
    const n = Math.max(1, Math.min(50, Number(q.n || q.cap || 0) || 0)) || null;
    const wantDebug = String(q.debug||"") === "1" || String(q.debug||"").toLowerCase() === "true";
    const trace = wantDebug ? [] : null;

    const cap = n || slotCap(slot, TZ);

    // 1) items (1X2)
    const { items, source, before, after } = await readItems(ymd, slot, trace, cap);

    // 2) tickets (KV → fallback derivation)
    const t0 = await readTickets(ymd, slot, trace);
    let tickets = t0.tickets;
    let tsrc = t0.source;

    if (!tickets) {
      // deriviramo iz union ili iz već učitanih items (što god imamo)
      // pokušaj union/lasta bez re-sortiranja KV trace-a po drugi put
      let baseArr = items && items.length ? items : [];
      if (!baseArr.length) {
        const { raw } = await kvGETraw(`vb:day:${ymd}:union`, trace);
        const arr = arrFromAny(J(raw));
        if (Array.isArray(arr) && arr.length) baseArr = arr;
      }
      tickets = splitMarkets(baseArr);
      tsrc = "derived-from-items";
    }

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
      policy_cap: Number(process.env.VB_LIMIT || 25) || 25,
      slot_cap: cap,
      ...(wantDebug ? { debug:{ trace, before, after, tickets_tried: t0.tried } } : {})
    };
    return res.status(200).json(payload);
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
