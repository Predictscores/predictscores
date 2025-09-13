// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo TZ_DISPLAY) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`,{ headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      trace && trace.push({ get:key, ok:r.ok, flavor:b.flavor, hit:!!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) { trace && trace.push({ get:key, ok:false, err:String(e?.message||e) }); }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value, trace) {
  const saved = [];
  const body = (typeof value === "string") ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{
        method:"POST", headers:{ Authorization:`Bearer ${b.tok}`, "Content-Type":"application/json" }, cache:"no-store", body
      });
      saved.push({ flavor:b.flavor, ok:r.ok });
    } catch (e) { saved.push({ flavor:b.flavor, ok:false, err:String(e?.message||e) }); }
  }
  trace && trace.push({ set:key, saved }); return saved;
}

/* ---------- utils ---------- */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const arrFromAny = x => Array.isArray(x) ? x
  : (x && typeof x==="object" && Array.isArray(x.items)) ? x.items
  : (x && typeof x==="object" && Array.isArray(x.football)) ? x.football
  : (x && typeof x==="object" && Array.isArray(x.list)) ? x.list : [];

function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }
function targetYmdForSlot(now, slot, tz){
  const h=hourInTZ(now,tz);
  if (slot==="late") return ymdInTZ(h<10?now:addDays(now,1), tz);
  if (slot==="am")   return ymdInTZ(h<15?now:addDays(now,1), tz);
  if (slot==="pm")   return ymdInTZ(h<15?now:addDays(now,1), tz);
  return ymdInTZ(now, tz);
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd   = targetYmdForSlot(now, slot, TZ);

    // prioritet: vbl_full:<ymd>:<slot> → vb:day:<ymd>:union → vb:day:<ymd>:<slot>
    const tried = [
      `vbl_full:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:${slot}`
    ];
    let baseArr = null, src = null;
    for (const k of tried) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (arr.length) { baseArr=arr; src=k; break; }
    }

    // ako baš nemamo ništa, zamrzni prazno
    if (!baseArr) {
      const key = `tickets:${ymd}:${slot}`;
      await kvSET(key, { btts:[], ou25:[], htft:[] }, trace);
      return res.status(200).json({ ok:true, ymd, slot, source:src, counts:{btts:0,ou25:0,htft:0} });
    }

    const conf = x => Number.isFinite(x?.confidence_pct)?x.confidence_pct:(Number(x?.confidence)||0);
    const kstart = x => { const k=x?.fixture?.date||x?.fixture_date||x?.kickoff||x?.kickoff_utc||x?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };
    const sorter = (a,b)=> (conf(b)-conf(a)) || (kstart(a)-kstart(b));

    const groups = { btts:[], ou25:[], htft:[] };

    for (const it of baseArr) {
      const m = it?.markets || {};
      // BTTS
      if (m?.btts && (Number.isFinite(m.btts.yes) || Number.isFinite(m.btts.no))) {
        groups.btts.push(it);
      }
      // OU 2.5
      if (m?.ou25 && (Number.isFinite(m.ou25.over) || Number.isFinite(m.ou25.under))) {
        groups.ou25.push(it);
      }
      // HT-FT
      if (m?.htft && (Number.isFinite(m.htft.hh) || Number.isFinite(m.htft.aa))) {
        groups.htft.push(it);
      }
    }

    groups.btts.sort(sorter); groups.ou25.sort(sorter); groups.htft.sort(sorter);
    groups.btts = groups.btts.slice(0,4);
    groups.ou25 = groups.ou25.slice(0,4);
    groups.htft = groups.htft.slice(0,4);

    const keySlot = `tickets:${ymd}:${slot}`;
    await kvSET(keySlot, groups, trace);

    // dnevni fallback ako ne postoji
    const { raw:rawDay } = await kvGETraw(`tickets:${ymd}`, trace);
    const jDay = J(rawDay);
    const hasDay = jDay && (Array.isArray(jDay.btts)||Array.isArray(jDay.ou25)||Array.isArray(jDay.htft));
    if (!hasDay) await kvSET(`tickets:${ymd}`, groups, trace);

    const counts = { btts: groups.btts.length, ou25: groups.ou25.length, htft: groups.htft.length };
    return res.status(200).json({ ok:true, ymd, slot, source:src, tickets_key:keySlot, counts });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
