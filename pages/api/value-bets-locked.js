// pages/api/value-bets-locked.js
// KV-only shortlist sa pametnim fallbackom (danas/slot→ostali slotovi→juče→prekjuče)
// + robustan parser koji razume JSON string, base64-gzip JSON i više naziva polja.
// Ne zove spoljne API-je.

const TZ = "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shiftDays(d, days) { const nd = new Date(d.getTime()); nd.setUTCDate(nd.getUTCDate()+days); return nd; }
function currentHour(tz = TZ){ return Number(new Intl.DateTimeFormat("en-GB",{hour:"2-digit",hour12:false,timeZone:tz}).format(new Date())); }
// late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59
function slotOfHour(h){ return h < 10 ? "late" : h < 15 ? "am" : "pm"; }
function currentSlot(tz = TZ){ return slotOfHour(currentHour(tz)); }
function orderForSlot(slot){ return slot==="late" ? ["late","am","pm"] : slot==="am" ? ["am","pm","late"] : ["pm","am","late"]; }

function gunzipBase64ToString(b64){
  try {
    const zlib = require("zlib");
    const buf = Buffer.from(b64, "base64");
    const out = zlib.gunzipSync(buf);
    return out.toString("utf8");
  } catch { return null; }
}
function tryDecode(raw){
  // 1) već je objekt ili niz
  if (raw && typeof raw === "object") return raw;
  if (Array.isArray(raw)) return raw;
  // 2) string → pokušaj JSON
  if (typeof raw === "string") {
    // probaj direktni JSON
    try { return JSON.parse(raw); } catch {/*not json*/}
    // probaj base64-gzip JSON
    const maybe = gunzipBase64ToString(raw);
    if (maybe) { try { return JSON.parse(maybe); } catch {/*ignore*/} }
    // probaj base64 *bez* gzip (retko)
    try {
      const dec = Buffer.from(raw, "base64").toString("utf8");
      try { return JSON.parse(dec); } catch {/*ignore*/}
    } catch {/*ignore*/}
  }
  return raw; // kao fallback
}

async function kvFetch(key){
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if(!base || !token) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");
  const url = `${base.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { exists:false, value:null };
  const j = await r.json().catch(()=>null);
  const raw = j?.result ?? null;
  if (raw == null) return { exists:false, value:null };
  return { exists:true, value: tryDecode(raw) };
}

function toArrayAny(x){
  if (!x) return [];
  if (Array.isArray(x)) return x;

  // najčešća polja
  if (Array.isArray(x.items)) return x.items;
  if (Array.isArray(x.value_bets)) return x.value_bets;
  if (Array.isArray(x.football)) return x.football;

  // česti wrapperi
  if (Array.isArray(x.data?.items)) return x.data.items;
  if (Array.isArray(x.data?.value_bets)) return x.data.value_bets;
  if (Array.isArray(x.data?.football)) return x.data.football;

  // moguće varijante iz rebuild-a
  if (Array.isArray(x.full)) return x.full;
  if (Array.isArray(x.slim)) return x.slim;
  if (Array.isArray(x.list)) return x.list;
  if (Array.isArray(x.arr)) return x.arr;
  if (Array.isArray(x.recs)) return x.recs;
  if (Array.isArray(x.recommendations)) return x.recommendations;
  if (Array.isArray(x.shortlist)) return x.shortlist;
  if (Array.isArray(x.football_full)) return x.football_full;
  if (Array.isArray(x.football_slim)) return x.football_slim;

  // embedovani pointer { key: "vbl:..." } ili { target:"..." }
  if (typeof x.key === "string") return [{ __pointer: x.key }];
  if (typeof x.target === "string") return [{ __pointer: x.target }];

  return [];
}

function uniqueByFixture(arr){
  const seen = new Set();
  const out = [];
  for (const it of arr){
    const id =
      it?.fixture_id ??
      it?.fixture?.id ??
      `${it?.league?.id || ""}:${it?.teams?.home?.name || it?.home}-${it?.teams?.away?.name || it?.away}`;
    if (!seen.has(id)){ seen.add(id); out.push(it); }
  }
  return out;
}

async function tryKey(key, tried){
  tried.push(key);
  const r = await kvFetch(key);
  if (!r.exists) return { ok:false, why:"missing" };
  const val = r.value;
  const arr = toArrayAny(val);

  // pointer deref
  if (arr.length === 1 && arr[0]?.__pointer){
    const ptr = arr[0].__pointer;
    tried.push(`→ ${ptr}`);
    const r2 = await kvFetch(ptr);
    if (r2.exists) {
      const a2 = toArrayAny(r2.value);
      if (a2.length) return { ok:true, items: uniqueByFixture(a2), source:`ptr:${ptr}` };
    }
    return { ok:false, why:"ptr-empty" };
  }

  if (arr.length) return { ok:true, items: uniqueByFixture(arr), source:key };
  return { ok:false, why:"no-array" };
}

export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = (req.query.ymd && String(req.query.ymd)) || ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || currentSlot(TZ);
    const n = Math.max(0, Math.min(200, Number(req.query.n ?? 0)));
    const debug = String(req.query.debug||"") === "1";

    const tried = [];
    let items = [];
    let src = "miss";

    // 1) danas: preferirani slot → ostali (vbl, vbl_full)
    for (const s of orderForSlot(qSlot)){
      for (const prefix of ["vbl","vbl_full"]){
        const k = `${prefix}:${ymd}:${s}`;
        const got = await tryKey(k, tried);
        if (got.ok){ items = got.items; src = got.source; break; }
      }
      if (items.length) break;
    }

    // 2) juče & 3) prekjuče (pm→am→late)
    for (const delta of [-1, -2]){
      if (items.length) break;
      const y = ymdInTZ(shiftDays(now, delta), TZ);
      for (const s of ["pm","am","late"]){
        for (const prefix of ["vbl","vbl_full"]){
          const k = `${prefix}:${y}:${s}`;
          const got = await tryKey(k, tried);
          if (got.ok){ items = got.items; src = got.source; break; }
        }
        if (items.length) break;
      }
    }

    // 4) pointer vb:day:<ymd>:last + locked varijante
    if (!items.length){
      const kDay = `vb:day:${ymd}:last`;
      const g1 = await tryKey(kDay, tried);
      if (g1.ok){ items = g1.items; src = g1.source; }
    }
    if (!items.length){
      const vars = ["vb:locked","vb_locked","vb-locked","locked:vbl"];
      for (const delta of [0,-1,-2]){
        if (items.length) break;
        const y = ymdInTZ(shiftDays(now, delta), TZ);
        for (const s of ["pm","am","late"]){
          for (const v of vars){
            const k = `${v}:${y}:${s}`;
            const g = await tryKey(k, tried);
            if (g.ok){ items = g.items; src = g.source; break; }
          }
          if (items.length) break;
        }
      }
    }

    if (!items.length){
      return res.status(200).json({
        ok: true,
        slot: qSlot,
        ymd,
        items: [],
        value_bets: [],
        football: [],
        source: "vb-locked:kv:miss·robust",
        ...(debug ? { debug_tried: tried } : {})
      });
    }

    if (n>0 && items.length>n) items = items.slice(0,n);

    return res.status(200).json({
      ok: true,
      slot: qSlot,
      ymd,
      items,
      value_bets: items,
      football: items,
      source: `vb-locked:kv:hit·${src}`,
      ...(debug ? { debug_tried: tried, size: items.length } : {})
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
