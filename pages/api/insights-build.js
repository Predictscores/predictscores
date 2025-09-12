// pages/api/insights-build.js
import { } from 'url';

export const config = { api: { bodyParser: false } };

/* ───────── TZ guard (Vercel: TZ je rezervisan; koristimo TZ_DISPLAY i sanitizujemo) ───────── */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  const s = raw.replace(/^:+/, "");
  try { new Intl.DateTimeFormat("en-GB", { timeZone: s }); return s; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ---------------- KV (REST) ---------------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/,""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/,""), tok: bT });
  return out;
}
async function kvGETraw(key, traceArr) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      traceArr && traceArr.push({ get:key, ok:r.ok, flavor:b.flavor, hit: !!raw });
      if (!r.ok) continue;
      return { raw, flavor:b.flavor };
    } catch (e) {
      traceArr && traceArr.push({ get:key, ok:false, flavor:b.flavor, err:String(e?.message||e) });
    }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value, traceArr) {
  const saved = [];
  const valueString = typeof value === "string" ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.tok}`, "Content-Type":"application/json" },
        cache: "no-store",
        body: valueString,
      });
      saved.push({ flavor:b.flavor, ok:r.ok });
    } catch (e) {
      saved.push({ flavor:b.flavor, ok:false, err:String(e?.message||e) });
    }
  }
  traceArr && traceArr.push({ set:key, saved });
  return saved;
}

/* ---------------- utils ---------------- */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
function arrFromAny(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object" && Array.isArray(x.items)) return x.items;
  if (x && typeof x === "object" && Array.isArray(x.football)) return x.football;
  if (x && typeof x === "object" && Array.isArray(x.list)) return x.list;
  return [];
}
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));

/* ---------------- main ---------------- */
export default async function handler(req, res) {
  try {
    const trace = [];
    const wantDebug = String(req.query.debug||"") === "1";

    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const h = hourInTZ(now, TZ);
    const slot = h < 10 ? "late" : h < 15 ? "am" : "pm";

    // 1) pokušaj da učitaš per-slot locked feed (vbl_full) ili dnevne izvore
    const triedKeys = [
      `tickets:${ymd}:${slot}`,
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
    ];
    let baseArr = null, src=null;

    for (const k of triedKeys) {
      const { raw } = await kvGETraw(k, trace);
      const arr = arrFromAny(J(raw));
      if (Array.isArray(arr) && arr.length) { baseArr = arr; src = k; break; }
    }

    if (!baseArr) {
      // nema ništa za izgradnju — očisti slot tikete da ne ostanu stari
      const key = `tickets:${ymd}:${slot}`;
      await kvSET(key, JSON.stringify({ btts:[], ou25:[], htft:[] }), trace);
      return res.status(200).json({ ok:true, ymd, slot, source: src, counts:{ btts:0, ou25:0, htft:0 }, note:"no-source-items" });
    }

    // 2) grupisanje specijala
    const groups = { btts:[], ou25:[], htft:[] };
    for (const it of baseArr) {
      const label = String(it?.market_label || it?.market || "").toUpperCase();
      if (label.includes("BTTS")) groups.btts.push(it);
      else if (label.includes("O/U 2.5") || label.includes("OVER 2.5") || label.includes("UNDER 2.5")) groups.ou25.push(it);
      else if (label.includes("HT-FT") || label.includes("HT/FT")) groups.htft.push(it);
    }

    // prioritizuj po confidence pa kickoff (ako postoji)
    const conf = x => Number.isFinite(x?.confidence_pct) ? x.confidence_pct : (Number(x?.confidence)||0);
    const kstart = x => {
      const k = x?.fixture?.date || x?.fixture_date || x?.kickoff || x?.kickoff_utc || x?.ts;
      const d = k ? new Date(k) : null;
      return Number.isFinite(d?.getTime?.()) ? d.getTime() : 0;
    };
    const sorter = (a,b)=> (conf(b)-conf(a)) || (kstart(a)-kstart(b));

    groups.btts.sort(sorter);
    groups.ou25.sort(sorter);
    groups.htft.sort(sorter);

    // 3) ograniči na max 4 po grupi (slot freeze logika je u rebuild/value-bets-locked)
    groups.btts = groups.btts.slice(0, 4);
    groups.ou25 = groups.ou25.slice(0, 4);
    groups.htft = groups.htft.slice(0, 4);

    // 4) upiši per-slot tikete
    const keySlot = `tickets:${ymd}:${slot}`;
    await kvSET(keySlot, JSON.stringify(groups), trace);

    // dnevni alias (opciono) — postavi ako nema ili je prazan
    const { raw:rawDay } = await kvGETraw(`tickets:${ymd}`, trace);
    const jDay = J(rawDay);
    const hasDay = jDay && (Array.isArray(jDay.btts) || Array.isArray(jDay.ou25) || Array.isArray(jDay.htft));
    if (!hasDay) {
      await kvSET(`tickets:${ymd}`, JSON.stringify(groups), trace);
    }

    const counts = { btts: groups.btts.length, ou25: groups.ou25.length, htft: groups.htft.length };
    return res.status(200).json({ ok:true, ymd, slot, source: src, tickets_key: keySlot, counts, debug: wantDebug ? { trace } : undefined });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
