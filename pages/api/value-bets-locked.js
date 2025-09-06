// pages/api/value-bets-locked.js
// Combined & Football feed (Kick-Off / Confidence)
// Robusniji parser za vrednosti iz KV (podržava duplo-JSON, b64 JSON, razne oblike)
// Ne menja response shape, ne dira History.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ----------------------------- KV (Vercel REST) ----------------------------- */
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

/* ----------------------------- parsing helpers ----------------------------- */
function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

function maybeDoubleJSON(raw) {
  // 1st parse
  let v = safeJSON(raw);
  if (v && typeof v !== "string") return v;
  // ako je string koji izgleda kao JSON, pokušaj još jednom
  if (typeof v === "string" && /^[\[{]/.test(v.trim())) {
    const v2 = safeJSON(v);
    if (v2) return v2;
  }
  // možda originalni raw već počinje sa [ ili { → direktno
  if (typeof raw === "string" && /^[\[{]/.test(raw.trim())) {
    const v3 = safeJSON(raw.trim());
    if (v3) return v3;
  }
  // poslednji pokušaj: base64 (nekad KV vrati b64 serijalizovano)
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(raw.trim())) {
      const buf = Buffer.from(raw.trim(), "base64").toString("utf8");
      const v4 = safeJSON(buf);
      if (v4) return v4;
      // ako je dupli i u b64
      if (typeof v4 === "string" && /^[\[{]/.test(v4.trim())) {
        const v5 = safeJSON(v4);
        if (v5) return v5;
      }
    }
  } catch {}
  return null;
}

function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.items)) return x.items;
  if (Array.isArray(x?.value_bets)) return x.value_bets;
  if (Array.isArray(x?.football)) return x.football;
  // ponekad listu drže pod .list ili .data
  if (Array.isArray(x?.list)) return x.list;
  if (Array.isArray(x?.data)) return x.data;
  return null;
}

/* ----------------------------- time helpers ---------------------------- */
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

/* ------------------------------ warm helpers --------------------------- */
function computeBaseUrl(req) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/,"");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

/* --------------------------- core load routine ------------------------- */
async function loadAll(ymd, slot, preferFull, diag) {
  const locked = preferFull
    ? [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`]
    : [`vbl:${ymd}:${slot}`, `vbl_full:${ymd}:${slot}`];

  for (const k of locked) {
    const { raw, flavor } = await kvGET_first(k, diag);
    const obj = maybeDoubleJSON(raw);
    const arr = arrFromAny(obj);
    if (arr && arr.length) return { arr, picked: k, flavor };
    // dijagnostika: ako imamo raw ali ne i arr, zabeleži uzorak
    if (raw && diag) {
      diag._sample = diag._sample || {};
      diag._sample[k] = raw.slice(0, 240);
    }
  }

  const alt = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:last`, `vb:day:${ymd}:union`];
  for (const k of alt) {
    const { raw, flavor } = await kvGET_first(k, diag);
    const obj = maybeDoubleJSON(raw);
    const arr = arrFromAny(obj);
    if (arr && arr.length) return { arr, picked: `${k}→fallback`, flavor };
    if (raw && diag) {
      diag._sample = diag._sample || {};
      diag._sample[k] = raw.slice(0, 240);
    }
  }

  return { arr: null, picked: null, flavor: null };
}

/* -------------------------------- handler ------------------------------ */
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

    // Peek režim za brzu proveru sadržaja ključa
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

    // autowarm: rebuild → pa refresh-odds force=1 → pa ponovo čitanje
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
        source: `vb-locked:kv:miss·${picked ? picked : 'none'}${wantDebug ? ':no-data' : ''}`,
        policy_cap: cap
      };
      if (wantDebug) out.debug = diag;
      return res.status(200).json(out);
    }

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
