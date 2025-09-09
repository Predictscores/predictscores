// pages/api/cron/refresh-odds.js
// Osvežava kvote za fixture ID listu i garantuje da lista postoji i kada nema fixtures:multi.
// Fallback redom: vb:day:<YMD>:<slot> → vb:day:<YMD>:union → vb:day:<YMD>:last → vbl_full:<YMD>:<slot> → fixtures:multi → AF /fixtures.
// Ako lista nastane iz fallback-a, seed-uje se u KV: fixtures:<YMD>:<slot> i fixtures:multi (back-compat).

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
  if (typeof x === "object") {
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

/* ---------------- API-Football ---------------- */
function afKey(){ return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || ""; }
async function afFetch(path, params={}){
  const key = afKey();
  if (!key) throw new Error("Missing API-Football key");
  const url = new URL(`https://v3.football.api-sports.io${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers:{ "x-apisports-key": key }, cache:"no-store" });
  const ct = r.headers.get("content-type")||"";
  const t = await r.text();
  if (!ct.includes("application/json")) throw new Error(`AF non-JSON ${r.status}: ${t.slice(0,120)}`);
  let j; try{ j=JSON.parse(t);}catch{ j=null; }
  if (!j) throw new Error("AF parse error");
  return j;
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
async function fetchFixturesIDsByDateAndSlot(ymd, slot){
  const bag = new Map();
  const tries = [
    { params: { date: ymd, timezone: TZ } },
    { params: { date: ymd } },
    { params: { from: ymd, to: ymd, timezone: TZ } },
    { params: { from: ymd, to: ymd } },
    { params: { date: ymd, timezone: "UTC" } },
  ];
  const HARD_CAP_PAGES = 12;
  for (const t of tries) {
    let page = 1;
    while (true) {
      const jf = await afFetch("/fixtures", { ...t.params, page });
      const arr = Array.isArray(jf?.response) ? jf.response : [];
      for (const fx of arr) {
        const it = mapFixture(fx);
        if (!it.fixture_id) continue;
        if (slotForKickoffISO(it.kickoff_utc) !== slot) continue;
        if (isYouthOrBanned(it)) continue;
        if (!bag.has(it.fixture_id)) bag.set(it.fixture_id, it);
      }
      const cur = Number(jf?.paging?.current || page);
      const tot = Number(jf?.paging?.total || page);
      if (!tot || cur >= tot) break;
      page++;
      if (page > HARD_CAP_PAGES) break;
    }
  }
  return Array.from(bag.keys());
}

/* ---------------- odds refresher ---------------- */
async function refreshOddsForIDs(ids, diag){
  let touched = 0;
  for (const id of ids) {
    try {
      const jo = await afFetch("/odds", { fixture: id });
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:Boolean(jo?.response?.length) });
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
    let list = [];            // ← uvek ARRAY, nikad null
    let seeded = false;

    async function takeFromKey(key, picker){
      tried.push(key);
      const { raw } = await kvGET(key, diag);
      const arr = arrFromAny(unpack(raw));
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const ids = (picker ? picker(arr) : arr).map(x => Number(picker ? x : x)).filter(Boolean);
      if (!ids.length) return false;
      // set only if we still don't have items
      if (list.length === 0) {
        list = Array.from(new Set(ids));
        pickedKey = key;
      }
      return true;
    }

    // Fallback chain (svaka grana bezbedno čuva list kao array)
    await takeFromKey(`vb:day:${ymd}:${slot}`, arr => arr.map(x => x?.fixture_id));
    if (list.length === 0) await takeFromKey(`vb:day:${ymd}:union`, arr => arr.map(x => x?.fixture_id));
    if (list.length === 0) await takeFromKey(`vb:day:${ymd}:last`,  arr => arr.map(x => x?.fixture_id));
    if (list.length === 0) await takeFromKey(`vbl_full:${ymd}:${slot}`);
    if (list.length === 0) await takeFromKey(`fixtures:multi`);

    // Ako i dalje nemamo listu — povuci iz AF i seed-uj
    if (list.length === 0) {
      const ids = await fetchFixturesIDsByDateAndSlot(ymd, slot);
      if (ids && ids.length) {
        list = Array.from(new Set(ids));
        // seed
        await kvSET(`fixtures:${ymd}:${slot}`, JSON.stringify(list), diag);
        await kvSET(`fixtures:multi`, JSON.stringify(list), diag);
        seeded = true;
      }
    }

    if (list.length === 0) {
      return res.status(200).json({
        ok: true, ymd, slot,
        inspected: 0, filtered: 0, targeted: 0, touched: 0,
        source: "refresh-odds:no-slot-matches",
        debug: wantDebug ? { tried, pickedKey, listLen: 0, forceSeed: seeded } : undefined
      });
    }

    const touched = await refreshOddsForIDs(list, diag);

    return res.status(200).json({
      ok: true, ymd, slot,
      inspected: list.length, filtered: 0, targeted: list.length, touched,
      source: pickedKey ? `refresh-odds:${pickedKey}` : "refresh-odds:fallback",
      debug: wantDebug ? { tried, pickedKey, listLen: list.length, forceSeed: seeded } : undefined
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
