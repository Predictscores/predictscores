// pages/api/value-bets-locked.js
// Combined & Football feed (Kick-Off / Confidence)
//
// Fix: čita iz SVIH dostupnih KV backenda (Vercel KV i/ili Upstash Redis REST)
// i uzima prvi koji sadrži ključ. Time pokrivamo slučaj kada refresh-odds
// upisuje u jedan backend, a ovaj endpoint je do sada čitao iz drugog.
//
// Prioritet ključeva:
//   1) vbl_full:<YMD>:<slot>, vbl:<YMD>:<slot>
//   2) vb:day:<YMD>:(slot|last|union)
// Auto-warm: opcioni rebuild ako je sve prazno (ne dira History)

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ----------------------------- KV backends ----------------------------- */
// Vraća listu dostupnih backend konekcija (redosled je deterministički).
function getKvBackends() {
  const out = [];
  const kvUrl = process.env.KV_REST_API_URL, kvTok = process.env.KV_REST_API_TOKEN;
  const upUrl = process.env.UPSTASH_REDIS_REST_URL, upTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (kvUrl && kvTok) out.push({ flavor: "vercel-kv", url: kvUrl.replace(/\/+$/,""), token: kvTok });
  if (upUrl && upTok) out.push({ flavor: "upstash-redis", url: upUrl.replace(/\/+$/,""), token: upTok });
  return out;
}

async function kvGETrawMulti(key) {
  const backends = getKvBackends();
  for (const b of backends) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${b.token}` },
        cache: "no-store",
      });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (typeof j?.result === "string" && j.result) {
        return { raw: j.result, backend: b.flavor };
      }
    } catch {
      // next backend
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

/* ------------------------------ rebuild IO ----------------------------- */
function computeBaseUrl(req) {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/+$/,"");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

/* --------------------------- core load routine ------------------------- */
async function tryLoadAllKeys(ymd, slot, preferFull, attempted, usedBackends) {
  let base = null, picked = null;

  const locked = preferFull
    ? [`vbl_full:${ymd}:${slot}`, `vbl:${ymd}:${slot}`]
    : [`vbl:${ymd}:${slot}`, `vbl_full:${ymd}:${slot}`];

  for (const k of locked) {
    attempted.push(k);
    const { raw, backend } = await kvGETrawMulti(k);
    if (backend) usedBackends.add(backend);
    const obj = toObj(raw);
    const arr = arrFromAny(obj);
    if (arr && arr.length) { base = arr; picked = `${k}`; return { base, picked }; }
  }

  const alt = [`vb:day:${ymd}:${slot}`, `vb:day:${ymd}:last`, `vb:day:${ymd}:union`];
  for (const k of alt) {
    attempted.push(k);
    const { raw, backend } = await kvGETrawMulti(k);
    if (backend) usedBackends.add(backend);
    const obj = toObj(raw);
    const arr = arrFromAny(obj);
    if (arr && arr.length) { base = arr; picked = `${k}→fallback`; return { base, picked }; }
  }

  return { base: null, picked: null };
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
    const allowWarm = String(q.autowarm ?? "1") !== "0"; // default ON

    const attempted = [];
    const usedBackends = new Set();

    let { base, picked } = await tryLoadAllKeys(ymd, slot, preferFull, attempted, usedBackends);

    // Auto-warm: probaj rebuild i re-čitanje (može da uhvati kasni upis iz refresh-odds)
    if ((!Array.isArray(base) || base.length === 0) && allowWarm) {
      try {
        const baseUrl = computeBaseUrl(req);
        await fetch(`${baseUrl}/api/cron/rebuild?slot=${slot}`, { cache:"no-store" }).catch(()=>{});
        await sleep(1200);
        ({ base, picked } = await tryLoadAllKeys(ymd, slot, preferFull, attempted, usedBackends));
      } catch { /* ignore */ }
    }

    if (!Array.isArray(base) || base.length === 0) {
      // Prazno – zadrži shape, dodaj debug sa info o backendima
      const out = {
        ok: true,
        slot, ymd,
        items: [], football: [], top3: [],
        source: `vb-locked:kv:miss·${picked ? picked : 'none'}${wantDebug ? ':no-data' : ''}`,
        policy_cap: cap,
      };
      if (wantDebug) out.debug = { attempted, kv_backends: Array.from(usedBackends) };
      return res.status(200).json(out);
    }

    const items = base.slice(0, cap);
    const top3  = base.slice(0, Math.min(3, cap));

    const out = {
      ok: true,
      slot, ymd,
      items,
      football: items, // legacy alias
      top3,
      source: `vb-locked:kv:hit·${picked}`,
      policy_cap: cap,
    };
    if (wantDebug) out.debug = { attempted, kv_backends: Array.from(usedBackends) };

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      items: [],
      football: [],
      top3: [],
      source: "vb-locked:error",
    });
  }
}
