// pages/api/insights-build.js
import { } from 'url';

export const config = { api: { bodyParser: false } };

/* ───────── TZ guard (Vercel: TZ je rezervisan; koristimo TZ_DISPLAY i sanitizujemo) ───────── */
function pickTZ() {
  const raw = (process.env.TZ || process.env.TZ_DISPLAY || "UTC").trim();
  const s = raw.replace(/^:+/, "");
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
async function kvSET(key, valueString, traceArr) {
  const saved = [];
  for (const b of kvBackends().filter(x=>x.flavor==="vercel-kv")) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.tok}`, "Content-Type":"application/json" },
        cache: "no-store",
        body: valueString,
      });
      saved.push({ flavor:b.flavor, ok:r.ok });
    } catch (e) {
      saved.push({ flavor:b.flavor, ok:false, err:String(e?.message||e) });
    }
  }
  traceArr && traceArr.push({ set:key, saved });
  return saved;
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
function confidence(it){
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob)) return Math.round(100*Number(it.model_prob));
  return 0;
}
function normMarket(raw){
  const s = String(raw||"").toLowerCase();
  if (s.includes("btts") || s.includes("both teams to score")) return "BTTS";
  if (s.includes("ht/ft") || s.includes("ht-ft") || s.includes("half time/full time")) return "HT-FT";
  if (s.includes("over 2.5") || s.includes("under 2.5") || s.includes("ou2.5") || s.includes("o/u 2.5") || s.includes("totals")) return "O/U 2.5";
  if (s === "1x2" || s.includes("match result") || s.includes("full time result")) return "1X2";
  return (s||"").trim() ? s.toUpperCase() : "1X2";
}
function kickoffFromMeta(it){
  const s =
    it?.kickoff_utc ||
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.fixture?.date || null;
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

/* ---------------- core: build tickets from locked/union ---------------- */
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

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control","no-store");

    const q = req.query || {};
    const now = new Date();
    const ymd = String(q.ymd||"").trim() || ymdInTZ(now, TZ);
    const qsSlot = String(q.slot||"").trim().toLowerCase();
    const slot = /^(am|pm|late)$/.test(qsSlot) ? qsSlot : deriveSlot(hourInTZ(now, TZ));
    const wantDebug = String(q.debug||"") === "1" || String(q.debug||"").toLowerCase() === "true";
    const trace = wantDebug ? [] : null;

    // 1) pokušaј locked → vb:day:slot → union
    const triedKeys = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
    ];
    let baseArr = null, src=null;

    for (const k of triedKeys) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (Array.isArray(arr) && arr.length) { baseArr = arr; src = k; break; }
    }

    if (!baseArr) {
      // nema ništa za izgradnju — očisti slot tikete da ne ostanu stari
      const key = `tickets:${ymd}:${slot}`;
      await kvSET(key, JSON.stringify({ btts:[], ou25:[], htft:[] }), trace);
      return res.status(200).json({ ok:true, ymd, slot, source: null, tickets_key: key, counts:{ btts:0, ou25:0, htft:0 }, note:"no-source-items" });
    }

    // 2) podeli i sortiraj
    const groups = splitMarkets(baseArr);

    // 3) set u per-slot ključ + (opcionalno) daily alias
    const keySlot = `tickets:${ymd}:${slot}`;
    await kvSET(keySlot, JSON.stringify(groups), trace);

    // dnevni alias (opciono) — postavi ako nema ili je prazan
    const { raw:rawDay } = await kvGETraw(`tickets:${ymd}`, trace);
    const jDay = J(rawDay);
    const hasDay = jDay && (Array.isArray(jDay.btts) || Array.isArray(jDay.ou25) || Array.isArray(jDay.htft));
    if (!hasDay) {
      await kvSET(`tickets:${ymd}`, JSON.stringify(groups), trace);
    }

    const counts = { btts: groups.btts.length, ou25: groups.ou25.length, htft: groups.htft.length };
    return res.status(200).json({ ok:true, ymd, slot, source: src, tickets_key: keySlot, counts, debug: wantDebug ? { trace } : undefined });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
