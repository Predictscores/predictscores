// pages/api/value-bets-locked.js
// Combined & Football feed (Kick-Off / Confidence)
// Čita iz SVIH dostupnih KV backend-a i uzima prvi nađen ključ.
// Debug sada pokazuje i po-backend status.
export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ---------------- KV multi-read ---------------- */
function getKvBackends() {
  const out = [];
  const kvUrl = process.env.KV_REST_API_URL, kvTok = process.env.KV_REST_API_TOKEN;
  const upUrl = process.env.UPSTASH_REDIS_REST_URL, upTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (kvUrl && kvTok) out.push({ flavor: "vercel-kv", url: kvUrl.replace(/\/+$/,""), token: kvTok });
  if (upUrl && upTok) out.push({ flavor: "upstash-redis", url: upUrl.replace(/\/+$/,""), token: upTok });
  return out;
}
async function kvGETrawFirst(key, dbg) {
  const out = getKvBackends();
  for (const b of out) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${b.token}` },
        cache: "no-store",
      });
      dbg && (dbg[b.flavor] = dbg[b.flavor] || {});
      if (!r.ok) { dbg && (dbg[b.flavor][key] = "miss(http)"); continue; }
      const j = await r.json().catch(() => null);
      if (typeof j?.result === "string" && j.result) {
        dbg && (dbg[b.flavor][key] = `hit(len=${j.result.length})`);
        return { raw: j.result, backend: b.flavor };
      }
      dbg && (dbg[b.flavor][key] = "miss(null)");
    } catch {
      dbg && (dbg[b.flavor][key] = "miss(err)");
    }
  }
  return { raw: null, backend: null };
}
function toObj(raw) { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } }
function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.items)) return x.items;
  if (Array.isArray(x?.value_bets)) return x.value_bets;
  if (Array.isArray(x?.football)) return x.football;
  return null;
}

/* ---------------- time helpers --------------- */
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

/* ---------------- auto-warm support ---------- */
function computeBaseUrl(req) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/,"");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

/* --------------- core loader ---------------- */
async function tryLoadAll(ymd, slot, preferFull, dbg) {
  const locked = preferFull
    ? [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`]
    : [`vbl:${ymd}:${slot}`, `vbl_full:${ymd}:${slot}`];

  for (const k of locked) {
    const { raw, backend } = await kvGETrawFirst(k, dbg);
    const arr = arrFromAny(toObj(raw));
    if (arr && arr.length) return { arr, picked: `${k}`, backend };
  }
  const alt = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:last`, `vb:day:${ymd}:union`];
  for (const k of alt) {
    const { raw, backend } = await kvGETrawFirst(k, dbg);
    const arr = arrFromAny(toObj(raw));
    if (arr && arr.length) return { arr, picked: `${k}→fallback`, backend };
  }
  return { arr: null, picked: null, backend: null };
}

/* ------------------- handler ---------------- */
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
    const allowWarm = String(q.autowarm ?? "1") !== "0";

    const dbg = wantDebug ? {} : null;

    let { arr, picked, backend } = await tryLoadAll(ymd, slot, preferFull, dbg);

    // autowarm: okini refresh-odds force=1 ako je baš prazno, pa probaj ponovo
    if ((!Array.isArray(arr) || arr.length===0) && allowWarm) {
      try {
        const baseUrl = computeBaseUrl(req);
        await fetch(`${baseUrl}/api/cron/refresh-odds?slot=${slot}&force=1`, { cache:"no-store" }).catch(()=>{});
        await sleep(1200);
        ({ arr, picked, backend } = await tryLoadAll(ymd, slot, preferFull, dbg));
      } catch { /* ignore */ }
    }

    if (!Array.isArray(arr) || arr.length===0) {
      const out = {
        ok: true, slot, ymd,
        items: [], football: [], top3: [],
        source: `vb-locked:kv:miss·${picked ? picked : 'none'}${wantDebug ? ':no-data' : ''}`,
        policy_cap: cap,
      };
      if (wantDebug) out.debug = { kv_probed: dbg || {} };
      return res.status(200).json(out);
    }

    const items = arr.slice(0, cap);
    const top3  = arr.slice(0, Math.min(3, cap));

    const out = {
      ok: true, slot, ymd,
      items, football: items, top3,
      source: `vb-locked:kv:hit·${picked}·${backend}`,
      policy_cap: cap,
    };
    if (wantDebug) out.debug = { kv_probed: dbg || {} };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({
      ok: false, error: String(e?.message || e),
      items: [], football: [], top3: [],
      source: "vb-locked:error",
    });
  }
}
