// pages/api/cron/refresh-odds.js
// - Napravi/nađi listu fixture ID-eva za ymd+slot (fallback preko više izvora)
// - Osveži kvote za te ID-eve (AF /odds) — ODDS_API_KEY ako postoji, inače API_FOOTBALL_KEY
// - Seed-uje fixtures:<YMD>:<slot> i fixtures:multi u KV
// ENV: TZ_DISPLAY, API_FOOTBALL_KEY, ODDS_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN

export const config = { api: { bodyParser: false } };

const TZ = (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) || "Europe/Belgrade";

/* ---------------- KV (Vercel REST) ---------------- */
function kvCfgs() {
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw  = process.env.KV_REST_API_TOKEN || "";
  const ro  = process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const list = [];
  if (url && rw) list.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) list.push({ flavor: "vercel-kv:ro", url, token: ro });
  return list;
}
async function kvGET(key, diag) {
  for (const c of kvCfgs()) {
    try {
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store",
      });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(()=>null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status: ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` });
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, valueString, diag) {
  const saved = [];
  for (const c of kvCfgs().filter(x=>x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: valueString,
      });
      saved.push({ flavor:c.flavor, ok:r.ok });
    } catch (e) {
      saved.push({ flavor:c.flavor, ok:false, err:String(e?.message||e) });
    }
  }
  diag && (diag.writes = diag.writes || []).push({ key, saved });
  return saved;
}
const J = s => { try { return JSON.parse(String(s||"")); } catch { return null; } };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object" && x) {
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value === "string") { const v = J(x.value); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
  }
  if (typeof x === "string") {
    const v = J(x);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return arrFromAny(v);
  }
  return null;
}
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v1 = J(raw);
  if (Array.isArray(v1)) return v1;
  if (v1 && typeof v1 === "object" && "value" in v1) {
    if (Array.isArray(v1.value)) return v1.value;
    if (typeof v1.value === "string") { const v2 = J(v1.value); if (Array.isArray(v2)) return v2; if (v2 && typeof v2==="object") return arrFromAny(v2); }
    return null;
  }
  if (v1 && typeof v1 === "object") return arrFromAny(v1);
  return null;
}

/* ---------------- time/slot helpers ---------------- */
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
function slotForKickoffISO(iso){
  const h = new Date(iso).toLocaleString("en-GB",{ hour:"2-digit", hour12:false, timeZone:TZ });
  const H = parseInt(h,10);
  return deriveSlot(H);
}
function isYouthOrBanned(item){
  const ln = (item?.league_name || item?.league?.name || "").toString();
  const tnH = (item?.home || item?.teams?.home?.name || "").toString();
  const tnA = (item?.away || item?.teams?.away?.name || "").toString();
  const s = `${ln} ${tnH} ${tnA}`;
  return /\bU(-|\s)?(17|18|19|20|21|22|23)\b/i.test(s) || /\bPrimavera\b/i.test(s) || /\bYouth\b/i.test(s);
}

/* ---------------- API-Football: direct host ---------------- */
const AF_BASE = "https://v3.football.api-sports.io";
const afFixturesHeaders = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || "").trim() });
const afOddsHeaders     = () => ({ "x-apisports-key": (process.env.ODDS_API_KEY || process.env.API_FOOTBALL_KEY || "").trim() });

async function afFetch(base, headers, path, params={}, diagTag, diag){
  const url = new URL(`${base}${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers, cache:"no-store" });
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  if (diag) (diag.af = diag.af || []).push({ host: base, tag: diagTag, path, params, status: r.status, ok: r.ok, results: j?.results, errors: j?.errors });
  return j || {};
}

function mapFixture(fx){
  const id = Number(fx?.fixture?.id);
  const ts = Number(fx?.fixture?.timestamp || 0)*1000 || Date.parse(fx?.fixture?.date || 0) || 0;
  const kick = new Date(ts).toISOString();
  return {
    fixture_id: id,
    league_name: fx?.league?.name,
    teams: { home: fx?.teams?.home?.name, away: fx?.teams?.away?.name },
    home: fx?.teams?.home?.name, away: fx?.teams?.away?.name,
    kickoff_utc: kick,
  };
}

/* ---------------- fixtures fetch (bez page na prvom pozivu) ---------------- */
async function fetchFixturesIDsByDateStrict(ymd, slot, diag){
  const variants = [
    { params: { date: ymd, timezone: TZ }, tag: "date+tz" },
    { params: { date: ymd },               tag: "date"    },
    { params: { from: ymd, to: ymd },      tag: "from-to" }, // bez timezone za ovaj mod
  ];
  const bag = new Map();
  for (const v of variants) {
    // 1) prvi poziv BEZ page
    const jf0 = await afFetch(AF_BASE, afFixturesHeaders(), "/fixtures", { ...v.params }, `fixtures:${v.tag}:p0`, diag);
    const arr0 = Array.isArray(jf0?.response) ? jf0.response : [];
    for (const fx of arr0) {
      const it = mapFixture(fx);
      if (!it.fixture_id) continue;
      if (slotForKickoffISO(it.kickoff_utc) !== slot) continue;
      if (isYouthOrBanned(it)) continue;
      bag.set(it.fixture_id, it);
    }
    // 2) dodatne strane samo ako postoji paging.total > 1
    const tot = Number(jf0?.paging?.total || 1);
    for (let page = 2; page <= Math.min(tot, 12); page++) {
      const jf = await afFetch(AF_BASE, afFixturesHeaders(), "/fixtures", { ...v.params, page }, `fixtures:${v.tag}:p${page}`, diag);
      const arr = Array.isArray(jf?.response) ? jf.response : [];
      for (const fx of arr) {
        const it = mapFixture(fx);
        if (!it.fixture_id) continue;
        if (slotForKickoffISO(it.kickoff_utc) !== slot) continue;
        if (isYouthOrBanned(it)) continue;
        bag.set(it.fixture_id, it);
      }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}
async function fetchFixturesIDsWholeDay(ymd, slot, diag){
  const variants = [
    { params: { date: ymd, timezone: TZ }, tag: "date+tz" },
    { params: { date: ymd },               tag: "date"    },
    { params: { from: ymd, to: ymd },      tag: "from-to" },
  ];
  const bag = new Map();
  for (const v of variants) {
    const jf0 = await afFetch(AF_BASE, afFixturesHeaders(), "/fixtures", { ...v.params }, `fixtures:${v.tag}:p0`, diag);
    const arr0 = Array.isArray(jf0?.response) ? jf0.response : [];
    for (const fx of arr0) {
      const it = mapFixture(fx);
      if (!it.fixture_id) continue;
      if (isYouthOrBanned(it)) continue;
      if (slotForKickoffISO(it.kickoff_utc) !== slot) continue;
      bag.set(it.fixture_id, it);
    }
    const tot = Number(jf0?.paging?.total || 1);
    for (let page = 2; page <= Math.min(tot, 12); page++) {
      const jf = await afFetch(AF_BASE, afFixturesHeaders(), "/fixtures", { ...v.params, page }, `fixtures:${v.tag}:p${page}`, diag);
      const arr = Array.isArray(jf?.response) ? jf.response : [];
      for (const fx of arr) {
        const it = mapFixture(fx);
        if (!it.fixture_id) continue;
        if (isYouthOrBanned(it)) continue;
        if (slotForKickoffISO(it.kickoff_utc) !== slot) continue;
        bag.set(it.fixture_id, it);
      }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}

/* ---------------- odds refresher (AF /odds, koristi ODDS_API_KEY) ---------------- */
async function refreshOddsForIDs(ids, diag){
  let touched = 0;
  for (const id of ids) {
    try {
      const jo = await afFetch(AF_BASE, afOddsHeaders(), "/odds", { fixture: id }, "odds", diag);
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:Boolean(jo?.response && jo.response.length) });
      touched++;
    } catch (e) {
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:false, err:String(e?.message||e) });
    }
  }
  return touched;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const wantDebug = String(q.debug ?? "") === "1";
  const diag = wantDebug ? {} : null;

  try {
    const now = new Date();
    const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot)))
      ? String(q.slot)
      : deriveSlot(hourInTZ(now, TZ));
    const tried = [];
    let pickedKey = null;
    let list = [];     // uvek array
    let seeded = false;

    async function takeFromKey(key, picker){
      tried.push(key);
      const { raw } = await kvGET(key, diag);
      const arr = arrFromAny(unpack(raw));
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const ids = (picker ? arr.map(picker) : arr).map(x => Number(x)).filter(Boolean);
      if (!ids.length) return false;
      if (list.length === 0) { list = Array.from(new Set(ids)); pickedKey = key; }
      return true;
    }

    // 1) KV fallback lanci
    await takeFromKey(`vb:day:${ymd}:${slot}`, x => x?.fixture_id);
    if (list.length === 0) await takeFromKey(`vb:day:${ymd}:union`, x => x?.fixture_id);
    if (list.length === 0) await takeFromKey(`vb:day:${ymd}:last`,  x => x?.fixture_id);
    if (list.length === 0) await takeFromKey(`vbl_full:${ymd}:${slot}`);
    if (list.length === 0) await takeFromKey(`fixtures:multi`);

    // 2) Ako KV nije dao ništa — probaj AF striktno pa ceo dan
    if (list.length === 0) {
      const strict = await fetchFixturesIDsByDateStrict(ymd, slot, diag);
      if (strict.length) {
        list = strict;
      } else {
        const whole = await fetchFixturesIDsWholeDay(ymd, slot, diag);
        if (whole.length) list = whole;
      }
      if (list.length) {
        await kvSET(`fixtures:${ymd}:${slot}`, JSON.stringify(list), diag);
        await kvSET(`fixtures:multi`, JSON.stringify(list), diag);
        seeded = true;
      }
    }

    // 3) Ako i dalje ništa — vrati dijagnostiku
    if (list.length === 0) {
      return res.status(200).json({
        ok: true,
        ymd, slot,
        inspected: 0, filtered: 0, targeted: 0, touched: 0,
        source: "refresh-odds:no-slot-matches",
        debug: wantDebug ? { tried, pickedKey, listLen: 0, forceSeed: seeded, af: diag?.af } : undefined
      });
    }

    // 4) Osveži kvote (koristi ODDS_API_KEY)
    const ids = Array.from(new Set(list));
    const touched = await refreshOddsForIDs(ids, diag);

    return res.status(200).json({
      ok: true,
      ymd, slot,
      inspected: ids.length,
      filtered: 0,
      targeted: ids.length,
      touched,
      source: pickedKey ? `refresh-odds:${pickedKey}` : "refresh-odds:fallback",
      debug: wantDebug ? { tried, pickedKey, listLen: ids.length, forceSeed: seeded, af: diag?.af, odds: diag?.odds } : undefined
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  } 
}
