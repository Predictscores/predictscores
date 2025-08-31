// pages/api/value-bets-locked.js
// KV-only shortlist sa pametnim fallbackom po slotovima i danima.
// Ne zove spoljne API-je. Ako nema današnjeg slota, vraća najbliži ne-prazan set iz KV.

const TZ = "Europe/Belgrade";

function pad(n){ return String(n).padStart(2,"0"); }
function ymdInTZ(d = new Date(), tz = TZ){
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const parts = fmt.formatToParts(d).reduce((a,p)=> (a[p.type]=p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function shiftDays(d, days){
  const nd = new Date(d.getTime());
  nd.setUTCDate(nd.getUTCDate()+days);
  return nd;
}
function currentHour(tz = TZ){
  return Number(new Intl.DateTimeFormat("en-GB",{hour:"2-digit", hour12:false, timeZone: tz}).format(new Date()));
}
function slotOfHour(h){
  // late = 00:00–09:59, am = 10:00–14:59, pm = 15:00–23:59
  return h < 10 ? "late" : h < 15 ? "am" : "pm";
}
function currentSlot(tz = TZ){ return slotOfHour(currentHour(tz)); }

function orderForSlot(slot){
  // Prioritet: traženi slot, pa ostali istog dana
  if (slot === "late") return ["late","am","pm"];
  if (slot === "am")   return ["am","pm","late"];
  return ["pm","am","late"];
}

async function kvGetRaw(key){
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if(!base || !token){
    throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN nisu postavljeni");
  }
  const url = `${base.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok){
    const t = await r.text().catch(()=>String(r.status));
    throw new Error(`KV get failed ${r.status}: ${t.slice(0,120)}`);
  }
  const j = await r.json().catch(()=>null);
  return j?.result ?? null;
}

async function kvGetJSON(key){
  const raw = await kvGetRaw(key);
  if (raw == null) return null;
  if (typeof raw === "string"){
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function takeItems(x){
  // podržava više oblika zapisa u KV
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.items)) return x.items;
  if (Array.isArray(x.value_bets)) return x.value_bets;
  if (Array.isArray(x.football)) return x.football;
  return [];
}

function uniqueByFixture(arr){
  const seen = new Set();
  const out = [];
  for (const it of arr){
    const id = it?.fixture_id ?? it?.fixture?.id ?? `${it?.league?.id || ""}:${it?.teams?.home?.name || it?.home}-${it?.teams?.away?.name || it?.away}`;
    if (!seen.has(id)){ seen.add(id); out.push(it); }
  }
  return out;
}

export default async function handler(req, res){
  try{
    const now = new Date();
    const ymd = (req.query.ymd && String(req.query.ymd)) || ymdInTZ(now, TZ);
    const qSlot = (req.query.slot && String(req.query.slot)) || currentSlot(TZ);
    const n = Math.max(0, Math.min(200, Number(req.query.n ?? 0))); // 0 = no limit
    const todayOrder = orderForSlot(qSlot);

    // Kandidati ključeva po prioritetu:
    const candidates = [];

    // 1) Danas: traženi slot pa ostali (vbl pa vbl_full)
    for (const s of todayOrder){
      candidates.push({ ymd, slot:s, key:`vbl:${ymd}:${s}`, kind:"vbl" });
      candidates.push({ ymd, slot:s, key:`vbl_full:${ymd}:${s}`, kind:"vbl_full" });
    }

    // 2) Juče: pm→am→late (vbl pa vbl_full)
    const ymd1 = ymdInTZ(shiftDays(now, -1), TZ);
    for (const s of ["pm","am","late"]){
      candidates.push({ ymd: ymd1, slot:s, key:`vbl:${ymd1}:${s}`, kind:"vbl" });
      candidates.push({ ymd: ymd1, slot:s, key:`vbl_full:${ymd1}:${s}`, kind:"vbl_full" });
    }

    // 3) Prekjuče: pm→am→late
    const ymd2 = ymdInTZ(shiftDays(now, -2), TZ);
    for (const s of ["pm","am","late"]){
      candidates.push({ ymd: ymd2, slot:s, key:`vbl:${ymd2}:${s}`, kind:"vbl" });
      candidates.push({ ymd: ymd2, slot:s, key:`vbl_full:${ymd2}:${s}`, kind:"vbl_full" });
    }

    let chosen = null;
    let items = [];
    for (const c of candidates){
      const data = await kvGetJSON(c.key);
      const arr = takeItems(data);
      if (arr && arr.length){
        items = uniqueByFixture(arr);
        chosen = c;
        break;
      }
    }

    // Ako i dalje nema ničega, vrati "miss" sa jasnim izvorom
    if (!items.length){
      return res.status(200).json({
        ok: true,
        slot: qSlot,
        ymd,
        items: [],
        value_bets: [],
        football: [],
        source: "vb-locked:kv:miss·fallback",
      });
    }

    // Opcioni cut (n)
    if (n > 0 && items.length > n) items = items.slice(0, n);

    return res.status(200).json({
      ok: true,
      slot: qSlot,
      ymd,
      items,
      // radi kompatibilnosti sa starijim frontovima:
      value_bets: items,
      football: items,
      source: `vb-locked:kv:hit·${chosen.kind}:${chosen.ymd}:${chosen.slot}`,
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
