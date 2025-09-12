// pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

/* TZ (samo TZ_DISPLAY; TZ je rezervisan na Vercel-u) */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* KV backends (Vercel KV i/ili Upstash) */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const val = typeof j?.result === "string" ? j.result : null;
      if (val) return { raw: val, flavor: b.flavor };
    } catch {}
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, value) {
  const saves = [];
  for (const b of kvBackends()) {
    const body = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.tok}`, "Content-Type": "application/json" },
        body
      });
      saves.push({ flavor: b.flavor, ok: r.ok });
    } catch (e) {
      saves.push({ flavor: b.flavor, ok: false, error: String(e?.message||e) });
    }
  }
  return saves;
}

/* Helpers */
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, hour: "2-digit" }).format(d));
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const kickoffFromMeta = it => {
  const ts = it?.fixture?.date || it?.fixture_date || it?.date || it?.ts;
  if (!ts) return null;
  const d = new Date(ts); return Number.isFinite(d?.getTime?.()) ? d : null;
};
const confidence = it => Number.isFinite(it?.confidence_pct) ? it.confidence_pct : (Number(it?.confidence)||0);
const isWeekend = (d, tz) => {
  const wd = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).formatToParts(d).find(p=>p.type==="weekday")?.value?.toLowerCase()?.includes("sat") || 0)
             || Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" }).format(d).startsWith("Sun"));
  // quick check:
  const day = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday:"short" }).format(d).match(/^(Sat|Sun)$/) ? 1 : 0);
  return !!day;
};
const now = () => new Date();

/* Caps iz ENV (workday/weekend) */
function capsFor(slot, d, tz) {
  const weekend = isWeekend(d, tz);
  const capLate = Number(process.env.CAP_LATE||6);
  const capAmWd = Number(process.env.CAP_AM_WD||15);
  const capPmWd = Number(process.env.CAP_PM_WD||15);
  const capAmWe = Number(process.env.CAP_AM_WE||20);
  const capPmWe = Number(process.env.CAP_PM_WE||20);
  if (slot === "late") return capLate;
  if (!weekend) return slot==="am" ? capAmWd : capPmWd;
  return slot==="am" ? capAmWe : capPmWe;
}

/* Combined pickovi (favorizuj 1X2, zatim OU/Btts) */
function buildCombined(list, take=3) {
  const m1x2 = list.filter(x => /^1x2$/i.test(x?.market_label||x?.market||""));
  const rest = list.filter(x => !/^1x2$/i.test(x?.market_label||x?.market||""));
  const sorted = [...m1x2, ...rest].sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));
  return sorted.slice(0, take);
}

export default async function handler(req, res) {
  try {
    const slot = String(req.query.slot||"auto").toLowerCase();
    const d = now();
    const ymd = ymdInTZ(d, TZ);
    const cap = capsFor(slot==="auto" ? (hourInTZ(d, TZ)<10?"late":hourInTZ(d,TZ)<15?"am":"pm") : slot, d, TZ);

    // 1) Učitaj bazu iz vb:day:<ymd>:<slot> || union || last
    const tried = [];
    async function firstHit(keys) {
      for (const k of keys) {
        const r = await kvGETraw(k); tried.push({ key:k, hit: !!r.raw });
        const arr = J(r.raw) || (J(J(r.raw)?.value||"")||[]);
        if (Array.isArray(arr) && arr.length) return { key: k, arr };
      }
      return { key: null, arr: [] };
    }
    const slotName = (slot==="auto" ? (hourInTZ(d, TZ)<10?"late":hourInTZ(d,TZ)<15?"am":"pm") : slot);
    const { key: srcKey, arr: base } = await firstHit([`vb:day:${ymd}:${slotName}`, `vb:day:${ymd}:union`, `vb:day:${ymd}:last`]);

    // 2) Slot filter + sort
    const only = base.filter(it => {
      const kd = kickoffFromMeta(it); if (!kd) return false;
      const h = hourInTZ(kd, TZ);
      return slotName==="late" ? h<10 : slotName==="am" ? (h>=10 && h<15) : h>=15;
    }).sort((a,b)=> (confidence(b)-confidence(a)) || ((kickoffFromMeta(a)?.getTime()||0)-(kickoffFromMeta(b)?.getTime()||0)));

    // 3) Cap
    const kept = only.slice(0, cap);

    // 4) Snimi vbl/vbl_full
    const saves = [];
    saves.push(...await kvSET(`vbl:${ymd}:${slotName}`, kept));
    saves.push(...await kvSET(`vbl_full:${ymd}:${slotName}`, kept));

    // 5) Tickets (učitaj dnevne → filtriraj buduće → snimi per-slot)
    const { raw: rawT } = await kvGETraw(`tickets:${ymd}`);
    const tObj = J(rawT) || {};
    const nowTs = d.getTime();
    const keepFuture = list => (Array.isArray(list)? list.filter(x => (kickoffFromMeta(x)?.getTime()||0) > nowTs) : []);
    const tPerSlot = {
      btts: keepFuture(tObj.btts).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
      ou25: keepFuture(tObj.ou25).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
      htft: keepFuture(tObj.htft).sort((a,b)=>confidence(b)-confidence(a)).slice(0,4),
    };
    const tSave = await kvSET(`tickets:${ymd}:${slotName}`, tPerSlot);

    // 6) Combined (per-slot + daily)
    const combined = buildCombined(kept, 3);
    await kvSET(`vb:day:${ymd}:${slotName}:combined`, combined);
    await kvSET(`vb:day:${ymd}:combined`, combined);

    return res.status(200).json({
      ok: true, ymd, slot: slotName,
      counts: { base: base.length, after_filters: only.length, kept: kept.length },
      source: srcKey,
      diag: { reads: tried, writes: { saves, tickets: tSave } },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message||e) });
  }
}
