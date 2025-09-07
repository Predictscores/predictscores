// pages/api/value-bets-locked.js
// Čita "locked" dnevne vrednosti. Ako posle slot-filtra ostane prazno,
// radi bezbedan fallback umesto da vrati prazan niz.
// Slot granice: late 00–09, am 10–14, pm 15–23.

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

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
        headers: { Authorization: `Bearer ${c.token}` },
        cache: "no-store",
      });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(() => null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || [], diag.reads.push({ flavor:c.flavor, key, status: ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` }));
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || [], diag.reads.push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` }));
    }
  }
  return { raw: null, flavor: null };
}

/* ---------------- parse helpers ---------------- */
function J(s){ try{ return JSON.parse(s); }catch{ return null; } }
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.value_bets)) return x.value_bets;
    if (Array.isArray(x.football)) return x.football;
    if (Array.isArray(x.list)) return x.list;
    if (Array.isArray(x.data)) return x.data;
  }
  return null;
}
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v1 = J(raw);
  if (Array.isArray(v1)) return v1;
  if (v1 && typeof v1 === "object" && "value" in v1) {
    if (Array.isArray(v1.value)) return v1.value;
    if (typeof v1.value === "string") {
      const v2 = J(v1.value);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") return arrFromAny(v2);
    }
    return null;
  }
  if (v1 && typeof v1 === "object") return arrFromAny(v1);
  return null;
}

/* ---------------- slot helpers ---------------- */
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(fmt.format(d),10);
}
function kickoffDate(x){
  const s =
    x?.kickoff_utc ||
    x?.datetime_local?.starting_at?.date_time ||
    x?.datetime_utc ||
    x?.start_time?.utc ||
    x?.start_time;
  if (!s || typeof s !== "string") return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function inSlotLocal(item, slot) {
  const d = kickoffDate(item);
  if (!d) return false; // KEY: ako ne znamo vreme, ne odbacuj
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const now = new Date();
  const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
  const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : "am";

  const diag = {};
  try {
    // 1) Primarni izvori
    const keysMain = [
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
    ];
    let items = null, source = null;
    for (const k of keysMain) {
      const { raw } = await kvGET(k, diag);
      const arr = arrFromAny(unpack(raw));
      if (arr && arr.length) { items = arr; source = k; break; }
    }

    // 2) Ako i dalje ništa → probaj meta izvore (vbl_full pa vbl)
    let fallback_used = false;
    if (!items || !items.length) {
      const keysMeta = [
        `vbl_full:${ymd}:${slot}`,
        `vbl:${ymd}:${slot}`,       // može biti lista minimalnih stavki
      ];
      for (const k of keysMeta) {
        const { raw } = await kvGET(k, diag);
        const arr = arrFromAny(unpack(raw));
        if (arr && arr.length) { items = arr; source = k; fallback_used = true; break; }
      }
    }

    // 3) Slot-filter, ali tolerantan
    const before = items ? items.length : 0;
    const filtered = (items || []).filter(x => inSlotLocal(x, slot));
    let out = filtered;

    // 4) Ako posle filtra ostane prazno → vrati nestriktno (fallback)
    if (!out.length && items && items.length) {
      out = items.slice(0, 60);
      fallback_used = true;
      source = `fallback:${source}`;
    }

    // 5) Top3 (ako ima confidence_pct)
    const top3 = out
      .filter(x => typeof x?.confidence_pct === "number")
      .sort((a,b)=> (b.confidence_pct - a.confidence_pct))
      .slice(0,3);

    return res.status(200).json({
      ok: true,
      slot, ymd,
      items: out,
      football: out,   // kompatibilno sa postojećim UI
      top3,
      source,
      policy_cap: 50,
      debug: { before, after: out.length, fallback_used }
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
