// pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

/* ── TZ (samo TZ_DISPLAY) ── */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ── KV helpers (Vercel KV i/ili Upstash) ── */
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
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const val = typeof j?.result === "string" ? j.result : null;
      if (val) return { raw: val, flavor: b.flavor };
    } catch {}
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, value) {
  const saves = [];
  const body = (typeof value === "string") ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.tok}`, "Content-Type":"application/json" },
        cache: "no-store",
        body
      });
      saves.push({ flavor: b.flavor, ok: r.ok });
    } catch (e) {
      saves.push({ flavor: b.flavor, ok: false, error: String(e?.message||e) });
    }
  }
  return saves;
}

/* ── time utils ── */
const J = s => { try { return JSON.parse(String(s||"")); } catch { return null; } };
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };

function canonicalSlot(x) {
  x = String(x||"auto").toLowerCase();
  return x==="late"||x==="am"||x==="pm" ? x : "auto";
}
function autoSlot(d, tz) { const h = hourInTZ(d, tz); return h<10?"late":(h<15?"am":"pm"); }

/* cilj: “sledeća po redu” instanca traženog slota */
function targetYmdForSlot(now, slot, tz) {
  const h = hourInTZ(now, tz);
  if (slot==="late")  return ymdInTZ(h<10 ? now : addDays(now,1), tz);
  if (slot==="am")    return ymdInTZ(h<15 ? now : addDays(now,1), tz);
  if (slot==="pm")    return ymdInTZ(h<15 ? now : addDays(now,1), tz);
  // auto → današnji
  return ymdInTZ(now, tz);
}

const kickoffFromMeta = it => {
  const ts = it?.fixture?.date || it?.fixture_date || it?.kickoff || it?.kickoff_utc || it?.ts;
  if (!ts) return null; const d = new Date(ts);
  return Number.isFinite(d?.getTime?.()) ? d : null;
};
const confidence = it => Number.isFinite(it?.confidence_pct) ? it.confidence_pct : (Number(it?.confidence)||0);

function capsFor(slot, isWeekend) {
  const capLate = Number(process.env.CAP_WEEKDAY_LATE||process.env.CAP_LATE||6);
  const capAmWd  = Number(process.env.CAP_WEEKDAY_AM||15);
  const capPmWd  = Number(process.env.CAP_WEEKDAY_PM||15);
  const capAmWe  = Number(process.env.CAP_WEEKEND_AM||20);
  const capPmWe  = Number(process.env.CAP_WEEKEND_PM||20);
  if (slot==="late") return capLate;
  if (!isWeekend) return slot==="am" ? capAmWd : capPmWd;
  return slot==="am" ? capAmWe : capPmWe;
}
const isWeekendYmd = (ymd, tz) => {
  const [y,m,d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  const wd = new Intl.DateTimeFormat("en-US",{ timeZone: tz, weekday:"short" }).format(dt);
  return wd==="Sat" || wd==="Sun";
};

/* combined: favorizuj 1X2 pa ostalo */
function buildCombined(list, take=3) {
  const m1x2 = list.filter(x => /^1x2$/i.test(x?.market_label||x?.market||""));
  const rest = list.filter(x => !/^1x2$/i.test(x?.market_label||x?.market||""));
  const sorted = [...m1x2, ...rest].sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));
  return sorted.slice(0, take);
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const qSlot = canonicalSlot(req.query.slot);
    const slot = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd  = targetYmdForSlot(now, slot, TZ);
    const weekend = isWeekendYmd(ymd, TZ);
    const cap = capsFor(slot, weekend);

    // 1) baza
    const tried = [];
    async function firstHit(keys) {
      for (const k of keys) {
        const r = await kvGETraw(k); tried.push({ key:k, hit: !!r.raw });
        const arr = J(r.raw) || (J(J(r.raw)?.value||"")||[]);
        if (Array.isArray(arr) && arr.length) return { key: k, arr };
      }
      return { key: null, arr: [] };
    }
    const { key: srcKey, arr: base } = await firstHit([
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`
    ]);

    // 2) filtriraj baš na taj YMD + slot prozor
    const only = base.filter(it => {
      const kd = kickoffFromMeta(it); if (!kd) return false;
      const ky = ymdInTZ(kd, TZ);
      if (ky !== ymd) return false;
      const h = hourInTZ(kd, TZ);
      return slot==="late" ? (h<10) : slot==="am" ? (h>=10 && h<15) : (h>=15);
    }).sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));

    const kept = only.slice(0, cap);

    // 3) snimi vbl/vbl_full
    const saves = [];
    saves.push(...await kvSET(`vbl:${ymd}:${slot}`, kept));
    saves.push(...await kvSET(`vbl_full:${ymd}:${slot}`, kept));

    // 4) per-slot tiketi iz dnevnih
    const rawT = await kvGETraw(`tickets:${ymd}`); 
    const tObj = J(rawT.raw) || {};
    const nowTs = now.getTime();
    const future = list => (Array.isArray(list)? list.filter(x => (kickoffFromMeta(x)?.getTime()||0) > nowTs) : []);
    const tPerSlot = {
      btts: future(tObj.btts).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
      ou25: future(tObj.ou25).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
      htft: future(tObj.htft).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
    };
    const tSave = await kvSET(`tickets:${ymd}:${slot}`, tPerSlot);

    // 5) combined (per-slot i dnevni)
    const combined = buildCombined(kept, 3);
    await kvSET(`vb:day:${ymd}:${slot}:combined`, combined);
    await kvSET(`vb:day:${ymd}:combined`, combined);

    return res.status(200).json({
      ok:true, ymd, slot,
      counts:{ base: base.length, after_filters: only.length, kept: kept.length },
      source: srcKey,
      diag:{ reads: tried, writes: { saves, tickets: tSave } }
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
