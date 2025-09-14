// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ (samo TZ_DISPLAY) ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------- KV (Vercel KV / Upstash) ---------- */
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
    } catch (e) {
      trace && trace.push({ get:key, ok:false, err:String(e?.message||e) });
    }
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

/* ---------- selection helpers ---------- */
const num = v => Number.isFinite(v) ? v : Number(v);
const MIN_ODDS = (()=>{ const v=Number(process.env.MIN_ODDS); return Number.isFinite(v)&&v>1 ? v : 1.5; })();
const pickPrice = (v)=>{ const n=num(v); return Number.isFinite(n) ? n : null; };
const kickoffISO = (it)=> it?.fixture?.date || it?.fixture_date || it?.kickoff || it?.kickoff_utc || it?.ts || null;
const confPct = (it)=> Number.isFinite(it?.confidence_pct) ? it.confidence_pct : (Number(it?.confidence)||0);
const byStrength = (a,b)=> (confPct(b)-confPct(a)) || (new Date(kickoffISO(a)).getTime() - new Date(kickoffISO(b)).getTime());

/* ---------- tickets snapshot record ---------- */
function snapshotItem(it, market_key, price, books_count, pick, extra={}){
  const fx = it?.fixture?.id || it?.fixture_id || it?.id || null;
  return {
    fixture_id: fx,
    league: it?.league || it?.fixture?.league || null,
    teams: it?.teams || it?.fixture?.teams || null,
    kickoff: kickoffISO(it),
    market_key, pick,
    price_snapshot: price ?? null,
    books_count_snapshot: Number(books_count)||0,
    frozen: true,
    snapshot_at: new Date().toISOString(),
    ...extra
  };
}

export default async function handler(req, res) {
  try {
    const trace = [];
    const now = new Date();

    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd   = targetYmdForSlot(now, slot, TZ);

    /* kandidati: prefer vbl_full → vbl → vb:day:<slot> → vb:day:union */
    const tried = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`
    ];
    let baseArr=null, source=null;
    for (const k of tried) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (arr.length){ baseArr=arr; source=k; break; }
    }

    if (!baseArr) {
      // no-clobber: ne pišemo prazno preko postojećih
      return res.status(200).json({ ok:true, ymd, slot, source:null, counts:{btts:0,ou25:0,htft:0,fh_ou15:0}, note:"no-source-items" });
    }

    const groups = { btts:[], ou25:[], htft:[], fh_ou15:[] };

    for (const it of baseArr) {
      const m = it?.markets || {};
      // BTTS (Yes)
      if (m?.btts) {
        const p = pickPrice(m.btts.yes);
        if (p && p >= MIN_ODDS) groups.btts.push({ it, price:p, books:m?.btts?.books_count, pick:"yes" });
      }
      // OU 2.5 (Over)
      if (m?.ou25) {
        const p = pickPrice(m.ou25.over);
        if (p && p >= MIN_ODDS) groups.ou25.push({ it, price:p, books:m?.ou25?.books_count, pick:"over" });
      }
      // HT-FT (HH/AA kao reprezentativne kombinacije)
      if (m?.htft) {
        // uzmi bolju (niža implied prob => viša kvota nije nužno "bolja"; ali oba su daleko iznad 1.5)
        const hh = pickPrice(m.htft.hh);
        const aa = pickPrice(m.htft.aa);
        const chosen = (hh && aa) ? (hh >= aa ? {p:hh, code:"hh"} : {p:aa, code:"aa"}) : (hh ? {p:hh, code:"hh"} : (aa ? {p:aa, code:"aa"} : null));
        if (chosen && chosen.p >= MIN_ODDS) groups.htft.push({ it, price:chosen.p, books:m?.htft?.books_count, pick:chosen.code });
      }
      // FH Over 1.5 (first-half OU 1.5)
      if (m?.fh_ou15) {
        const p = pickPrice(m.fh_ou15.over);
        if (p && p >= MIN_ODDS) groups.fh_ou15.push({ it, price:p, books:m?.fh_ou15?.books_count, pick:"over" });
      }
    }

    // sortiraj po "snazi"
    for (const k of Object.keys(groups)) groups[k].sort((a,b)=> byStrength(a.it,b.it));

    // uzmi tačno 4 po grupi (ako fali, uzmi koliko ima — ne prepisuj stare nulu preko postojećih)
    const top = {
      btts: groups.btts.slice(0,4),
      ou25: groups.ou25.slice(0,4),
      htft: groups.htft.slice(0,4),
      fh_ou15: groups.fh_ou15.slice(0,4)
    };

    const totalNew = top.btts.length + top.ou25.length + top.htft.length + top.fh_ou15.length;

    // no-clobber: ako nemamo ništa validno, ne diramo postojeće tikete
    const keySlot = `tickets:${ymd}:${slot}`;
    if (totalNew === 0) {
      trace.push({ note:"no-clobber (no-valid-candidates)" });
      return res.status(200).json({ ok:true, ymd, slot, source, counts:{btts:0,ou25:0,htft:0,fh_ou15:0}, debug:{ trace } });
    }

    // snapshot (strogo zamrzavanje: selekcije + cene)
    const snap = { btts:[], ou25:[], htft:[], fh_ou15:[] };
    for (const row of top.btts)   snap.btts.push(snapshotItem(row.it,   "btts",     row.price, row.books, row.pick));
    for (const row of top.ou25)   snap.ou25.push(snapshotItem(row.it,   "ou25",     row.price, row.books, row.pick));
    for (const row of top.htft)   snap.htft.push(snapshotItem(row.it,   "htft",     row.price, row.books, row.pick));
    for (const row of top.fh_ou15) snap.fh_ou15.push(snapshotItem(row.it,"fh_ou15", row.price, row.books, row.pick));

    await kvSET(keySlot, snap, trace);

    // upiši dnevni fallback (ako ne postoji)
    const { raw:rawDay } = await kvGETraw(`tickets:${ymd}`, trace);
    const jDay = J(rawDay);
    const hasDay = jDay && (Array.isArray(jDay.btts)||Array.isArray(jDay.ou25)||Array.isArray(jDay.htft)||Array.isArray(jDay.fh_ou15));
    if (!hasDay) await kvSET(`tickets:${ymd}`, snap, trace);

    const counts = { btts: snap.btts.length, ou25: snap.ou25.length, htft: snap.htft.length, fh_ou15: snap.fh_ou15.length };
    return res.status(200).json({ ok:true, ymd, slot, source, tickets_key:keySlot, counts, min_odds:MIN_ODDS, debug:{ trace } });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
