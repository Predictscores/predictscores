// pages/api/value-bets-locked.js
// Combined & Football feed (Kick-Off / Confidence)
// Fix: vrednosti u KV mogu biti upakovane kao {"value":"[...]"} (string JSON).
// Ovaj reader to detektuje i raspakuje bez menjanja ostatka sistema.
// NOVO: podrška za ?slim=1 (vrati "slim" oblik bez novih fajlova).
// NOVO: slot granice (late=00–09, am=10–14, pm=15–23) + server-side filter po slotu.

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

// Raspakuje sledeće formate:
// - "[{...}]" (čist JSON niz, kao string)
// - {"value":"[...]"}
// - {"value":[...]}  (ako je već niz)
// - duplo-JSON (string koji sadrži string JSON-a)
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;

  // 1) prvi pokušaj parse-a
  let v1 = safeJSON(raw);

  // Ako je već niz ili objekat sa poljima – nastavi dalje
  if (Array.isArray(v1)) return v1;

  // Ako je objekat koji sadrži .value
  if (v1 && typeof v1 === "object" && "value" in v1) {
    const inner = v1.value;
    if (Array.isArray(inner)) return inner;
    if (typeof inner === "string") {
      const v2 = safeJSON(inner);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") return v2; // možda objekat sa .items itd.
    }
    return v1; // vrati objekat; arrFromAny će probati da izvuče listu
  }

  // Ako je posle prvog parse-a dobiven string koji izgleda kao JSON → parse opet
  if (typeof v1 === "string" && /^[\[{]/.test(v1.trim())) {
    const v2 = safeJSON(v1);
    if (Array.isArray(v2) || (v2 && typeof v2 === "object")) return v2;
  }

  // Ako originalni raw izgleda kao JSON (bez prvog parse-a)
  if (/^[\[{]/.test(raw.trim())) {
    const v3 = safeJSON(raw.trim());
    if (Array.isArray(v3) || (v3 && typeof v3 === "object")) return v3;
  }

  return v1; // možda je null; arrFromAny će to odbiti
}

function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x.items)) return x.items;
  if (Array.isArray(x.value_bets)) return x.value_bets;
  if (Array.isArray(x.football)) return x.football;
  if (Array.isArray(x.list)) return x.list;
  if (Array.isArray(x.data)) return x.data;
  // čest slučaj: { value: "[...]" } ili { value: [...] }
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

/* --------- SLIM transform (bez menjanja default ponašanja) --------- */
function toSlimItem(x){
  return {
    fixture_id: x?.fixture_id ?? x?.fixture?.id ?? null,
    league_name: x?.league_name ?? x?.league?.name ?? null,
    league_country: x?.league_country ?? x?.league?.country ?? null,
    home: x?.home ?? x?.teams?.home?.name ?? x?.teams?.home ?? null,
    away: x?.away ?? x?.teams?.away?.name ?? x?.teams?.away ?? null,
    kickoff_utc: x?.kickoff_utc ?? x?.datetime_local?.starting_at?.date_time ?? null,
    pick: x?.pick ?? x?.selection_label ?? null,
    pick_code: x?.pick_code ?? null,
    confidence_pct: x?.confidence_pct ?? (x?.model_prob ? Math.round(100 * x.model_prob) : null),
    price: x?.odds?.price ?? null,
  };
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

// SLOT GRANICE: late 00–09, am 10–14, pm 15–23
function deriveSlot(h){
  if (h < 10) return "late";  // 00:00–09:59
  if (h < 15) return "am";    // 10:00–14:59
  return "pm";                // 15:00–23:59
}

function computeBaseUrl(req) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/,"");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

/* ---------------- kickoff helpers + slot filter ---------------- */
function kickoffDate(x){
  // pokušaji uobičajenih polja
  const s =
    x?.kickoff_utc ||
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_utc ||
    x?.start_time?.utc ||
    x?.start_time;

  if (!s || typeof s !== "string") return null;

  // Date će ispravno parsirati ISO sa ofsetom (npr. ...+02:00)
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// vrati true ako item pripada slotu po satu u Europe/Belgrade
function inSlotLocal(item, slot) {
  const d = kickoffDate(item);
  if (!d) return true; // ako ne znamo vreme, ne odbacuj
  const h = hourInTZ(d, TZ);

  if (slot === "late") return h < 10;              // 00–09
  if (slot === "am")   return h >= 10 && h < 15;   // 10–14
  return h >= 15;                                   // pm 15–23
}

/* ---------------- core load ---------------- */
async function loadAll(ymd, slot, preferFull, diag) {
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
    res.setHeader("Cache-Control", "no-store");
    const q = req.query || {};
    const now = new Date();
    const ymd = (q.ymd && String(q.ymd).match(/^\d{4}-\d{2}-\d{2}$/)) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(q.slot)) ? q.slot : deriveSlot(hourInTZ(now, TZ));
    const cap = Math.max(1, Math.min(Number(q.n ?? q.limit ?? 50), 200));
    const wantDebug = String(q.debug ?? "") === "1";
    const preferFull = String(q.full ?? "") === "1";
    const allowWarm  = String(q.autowarm ?? "1") !== "0";
    // robustan slim mod
    const smRaw = String(q.slim ?? q.shape ?? q.format ?? q.mode ?? "").toLowerCase().trim();
    const ua    = String(req.headers["user-agent"] || "").toLowerCase();
    const slimMode = ["1","true","yes","y","on","slim","s"].includes(smRaw) || /snapshot/.test(ua);

    // Peek za brzu proveru ključa
    if (q.peek) {
      const diag = {};
      const { raw, flavor, url } = await kvGET_first(String(q.peek), diag);
      return res.status(200).json({
        ok:true, peek:String(q.peek), flavor, url,
        raw_present: !!raw, raw_len: raw ? raw.length : 0,
        sample: raw ? raw.slice(0, 240) : null,
        debug: diag
      });
    }

    const diag = wantDebug ? {} : null;

    let { arr, picked, flavor } = await loadAll(ymd, slot, preferFull, diag);

    // autowarm: rebuild → refresh-odds(force) → retry
    if ((!arr || !arr.length) && allowWarm) {
      try {
        const baseUrl = computeBaseUrl(req);
        await fetch(`${baseUrl}/api/cron/rebuild?slot=${slot}`, { cache:"no-store" }).catch(()=>{});
        await sleep(800);
        ({ arr, picked, flavor } = await loadAll(ymd, slot, preferFull, diag));
        if (!arr || !arr.length) {
          await fetch(`${baseUrl}/api/cron/refresh-odds?slot=${slot}&force=1`, { cache:"no-store" }).catch(()=>{});
          await sleep(1200);
          ({ arr, picked, flavor } = await loadAll(ymd, slot, preferFull, diag));
        }
      } catch {}
    }

    if (!arr || !arr.length) {
      const out = {
        ok: true, slot, ymd,
        items: [], football: [], top3: [],
        source: `vb-locked:kv:${slimMode?'miss-slim':'miss'}·${picked ? picked : 'none'}${wantDebug ? ':no-data' : ''}`,
        policy_cap: cap
      };
      if (wantDebug) out.debug = diag;
      return res.status(200).json(out);
    }

    // FILTER PO SLOTU (Europe/Belgrade) → zadrži samo mečeve u traženom prozoru
    const filtered = arr.filter(it => inSlotLocal(it, slot));

    // Ako filtriran skup prazan, vrati prazan (ne izmišljamo mečeve iz drugih slotova)
    if (!filtered.length) {
      const out = {
        ok: true, slot, ymd,
        items: [], football: [], top3: [],
        source: `vb-locked:kv:hit-empty-after-slot-filter·${picked}·${flavor}`,
        policy_cap: cap
      };
      if (wantDebug) out.debug = diag;
      return res.status(200).json(out);
    }

    // default (full) ostaje potpuno isto, samo sada na slot-filterovanom skupu
    let items = filtered.slice(0, cap);
    let sourceTag = `vb-locked:kv:hit·${picked}·${flavor}`;

    // slim mod: mapiraj u lagani oblik + vrati value_bets/football/items identično
    if (slimMode) {
      items = items.map(toSlimItem);
      sourceTag = `vb-locked:kv:hit-slim·${picked}·${flavor}`;
      return res.status(200).json({
        ok: true, slot, ymd,
        value_bets: items, football: items, items,
        source: sourceTag,
        policy_cap: cap,
        ...(wantDebug ? { debug: diag } : {})
      });
    }

    // full mod (bez promene ponašanja)
    const top3  = filtered.slice(0, Math.min(3, cap));
    const out = {
      ok: true, slot, ymd,
      items, football: items, top3,
      source: sourceTag,
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
