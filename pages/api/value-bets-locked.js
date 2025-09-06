// pages/api/value-bets-locked.js
// Combined & Football feed (Kick-Off / Confidence)
// Robustan reader za Vercel KV: vrednosti mogu biti i {"value":"[...]"} ili {"value":[...]}.
// Dodatno: striktno poštuj ?slot= (am/pm/late) i NIKAD ne vrati drugi slot.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ---------------- KV (Vercel REST, RW/RO token) ---------------- */
function getKvCfgs() {
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw  = process.env.KV_REST_API_TOKEN || "";
  const ro  = process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const out = [];
  if (url && rw) out.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) out.push({ flavor: "vercel-kv:ro", url, token: ro });
  return out;
}

async function kvGET_first(key, diag) {
  const cfgs = getKvCfgs();
  for (const c of cfgs) {
    try {
      const u = `${c.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store" });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(() => null) : null;
      const val = j && typeof j.result === "string" ? j.result : null;
      diag && (diag[c.flavor] = diag[c.flavor] || {},
               diag[c.flavor][key] = ok ? (val ? `hit(len=${val.length})` : "miss(null)") : `miss(http ${r.status})`,
               diag[c.flavor]._url = c.url);
      if (val) return { raw: val, flavor: c.flavor, url: c.url };
    } catch (e) {
      diag && (diag[c.flavor] = diag[c.flavor] || {},
               diag[c.flavor][key] = `miss(err:${String(e?.message||e).slice(0,60)})`);
    }
  }
  return { raw: null, flavor: null, url: null };
}

/* ---------------- parsing helpers (robust) ---------------- */
function safeJSON(s){ try{ return JSON.parse(s); }catch{ return null; } }

// Raspakivanje: "[...]" | {"value":"[...]"} | {"value":[...]} | duplo-JSON string
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v1 = safeJSON(raw);
  if (Array.isArray(v1)) return v1;

  if (v1 && typeof v1 === "object" && "value" in v1) {
    const inner = v1.value;
    if (Array.isArray(inner)) return inner;
    if (typeof inner === "string") {
      const v2 = safeJSON(inner);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") return v2;
    }
    return v1; // arrFromAny će pokušati da izvuče listu
  }
  if (typeof v1 === "string" && /^[\[{]/.test(v1.trim())) {
    const v2 = safeJSON(v1);
    if (Array.isArray(v2) || (v2 && typeof v2 === "object")) return v2;
  }
  if (/^[\[{]/.test(raw.trim())) {
    const v3 = safeJSON(raw.trim());
    if (Array.isArray(v3) || (v3 && typeof v3 === "object")) return v3;
  }
  return v1;
}

function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.items)) return x.items;
  if (Array.isArray(x.value_bets)) return x.value_bets;
  if (Array.isArray(x.football)) return x.football;
  if (Array.isArray(x.list)) return x.list;
  if (Array.isArray(x.data)) return x.data;
  if (Array.isArray(x.value)) return x.value;
  if (typeof x.value === "string") {
    const v = safeJSON(x.value);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      if (Array.isArray(v.items)) return v.items;
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.football)) return v.football;
      if (Array.isArray(v.list)) return v.list;
      if (Array.isArray(v.data)) return v.data;
    }
  }
  return null;
}

/* ---------------- time + warm helpers ---------------- */
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(fmt.format(d),10);
}
function deriveSlot(h){ if (h<12) return "am"; if (h<18) return "pm"; return "late"; }
function computeBaseUrl(req) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/,"");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

/* ---------------- loader (STRICT slot) ---------------- */
async function loadAllStrict(ymd, slot, preferFull, diag) {
  // Traži SAMO zadati slot; nikakav drugi!
  const locked = preferFull
    ? [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`]
    : [`vbl:${ymd}:${slot}`, `vbl_full:${ymd}:${slot}`];

  for (const k of locked) {
    const { raw, flavor } = await kvGET_first(k, diag);
    const obj = unpack(raw);
    const arr = arrFromAny(obj);
    if (arr && arr.length) return { arr, picked: k, flavor };
    if (raw && diag) { diag._sample = diag._sample || {}; diag._sample[k] = raw.slice(0, 240); }
  }

  const alt = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:last`, `vb:day:${ymd}:union`];
  for (const k of alt) {
    const { raw, flavor } = await kvGET_first(k, diag);
    const obj = unpack(raw);
    const arr = arrFromAny(obj);
    if (arr && arr.length) return { arr, picked: `${k}→fallback`, flavor };
    if (raw && diag) { diag._sample = diag._sample || {}; diag._sample[k] = raw.slice(0, 240); }
  }

  return { arr: null, picked: null, flavor: null };
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    // hard no-cache na svim CDN slojevima
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "no-store");
    res.setHeader("CDN-Cache-Control", "no-store");

    const q = req.query || {};
    const now = new Date();
    const ymd = (q.ymd && String(Array.isArray(q.ymd) ? q.ymd[0] : q.ymd).match(/^\d{4}-\d{2}-\d{2}$/))
      ? String(Array.isArray(q.ymd) ? q.ymd[0] : q.ymd)
      : ymdInTZ(now, TZ);

    // NORMALIZUJ slot iz query-ja (string!), inače deriviraj iz sata
    const qSlotRaw = Array.isArray(q.slot) ? q.slot[0] : q.slot;
    const qSlot     = typeof qSlotRaw === "string" ? qSlotRaw.toLowerCase().trim() : "";
    const slot = /^(am|pm|late)$/.test(qSlot) ? qSlot : deriveSlot(hourInTZ(now, TZ));

    const cap = Math.max(1, Math.min(Number(Array.isArray(q.n) ? q.n[0] : (q.n ?? q.limit ?? 50)), 200));
    const wantDebug = String(Array.isArray(q.debug) ? q.debug[0] : q.debug ?? "") === "1";
    const preferFull = String(Array.isArray(q.full) ? q.full[0] : q.full ?? "") === "1";
    const allowWarm  = String(Array.isArray(q.autowarm) ? q.autowarm[0] : q.autowarm ?? "1") !== "0";

    // Peek util
    if (q.peek) {
      const diag = {};
      const key = String(Array.isArray(q.peek) ? q.peek[0] : q.peek);
      const { raw, flavor, url } = await kvGET_first(key, diag);
      return res.status(200).json({
        ok:true, peek:key, flavor, url,
        raw_present: !!raw, raw_len: raw ? raw.length : 0,
        sample: raw ? raw.slice(0, 240) : null,
        debug: diag
      });
    }

    const diag = wantDebug ? { meta:{ requested_slot:slot, ymd } } : null;

    let { arr, picked, flavor } = await loadAllStrict(ymd, slot, preferFull, diag);

    // autowarm: rebuild → refresh-odds(force) → retry (SAMO za taj slot)
    if ((!arr || !arr.length) && allowWarm) {
      try {
        const baseUrl = computeBaseUrl(req);
        await fetch(`${baseUrl}/api/cron/rebuild?slot=${slot}`, { cache:"no-store" }).catch(()=>{});
        await sleep(800);
        ({ arr, picked, flavor } = await loadAllStrict(ymd, slot, preferFull, diag));
        if (!arr || !arr.length) {
          await fetch(`${baseUrl}/api/cron/refresh-odds?slot=${slot}&force=1`, { cache:"no-store" }).catch(()=>{});
          await sleep(1200);
          ({ arr, picked, flavor } = await loadAllStrict(ymd, slot, preferFull, diag));
        }
      } catch {}
    }

    // Ako i dalje nema ništa – jasno signalizuj koji slot je tražen
    if (!arr || !arr.length) {
      const out = {
        ok: true, slot, ymd,
        items: [], football: [], top3: [],
        source: `vb-locked:kv:miss·${picked ? picked : 'none'}`,
        policy_cap: cap
      };
      if (wantDebug) out.debug = diag;
      return res.status(200).json(out);
    }

    // Normalan izlaz (nema nikakvog menjanja forme)
    const items = arr.slice(0, cap);
    const top3  = arr.slice(0, Math.min(3, cap));
    const out = {
      ok: true, slot, ymd,
      items, football: items, top3,
      source: `vb-locked:kv:hit·${picked}·${flavor}`,
      policy_cap: cap
    };
    if (wantDebug) out.debug = diag;
    return res.status(200).json(out);

  } catch (e) {
    return res.status(200).json({
      ok: false, error: String(e?.message || e),
      items: [], football: [], top3: [],
      source: "vb-locked:error",
    });
  }
}
