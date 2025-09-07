// pages/api/value-bets-locked.js
// Čita "locked" dnevne vrednosti za dati slot.
// PRIORITET: vb:day:<ymd>:<slot> → vb:day:<ymd>:(union|last) → vbl_full:<ymd>:<slot> → vbl:<ymd>:<slot>
// Slot granice: late 00–09, am 10–14, pm 15–23. Strogo: stavke bez kickoff-a se ne puštaju.

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
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(fmt.format(d),10);
}
function kickoffDate(x){
  const ts = x?.fixture?.timestamp ?? x?.timestamp;
  if (typeof ts === "number" && isFinite(ts)) {
    const d = new Date(ts * 1000);
    if (!isNaN(d.getTime())) return d;
  }
  const s =
    x?.kickoff_utc ||
    x?.datetime_local?.starting_at?.date_time ||
    x?.fixture?.date ||
    x?.datetime_utc ||
    x?.start_time?.utc ||
    x?.start_time;
  if (!s || typeof s !== "string") return null;
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}
function inSlotLocal(item, slot) {
  const d = kickoffDate(item);
  if (!d) return false; // STROGO: bez vremena ne prolazi
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
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
    // 1) Primarni izvori: vb:day*
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

    // 2) Ako nema vb:day → meta izvori: vbl_full pa vbl
    if (!items || !items.length) {
      const keysMeta = [
        `vbl_full:${ymd}:${slot}`,
        `vbl:${ymd}:${slot}`,
      ];
      for (const k of keysMeta) {
        const { raw } = await kvGET(k, diag);
        const arr = arrFromAny(unpack(raw));
        if (arr && arr.length) { items = arr; source = k; break; }
      }
    }

    const before = items ? items.length : 0;
    const filtered = (items || []).filter(x => inSlotLocal(x, slot));
    const out = filtered;

    // 3) top3 (po confidence_pct ako postoji)
    const top3 = out
      .filter(x => typeof x?.confidence_pct === "number")
      .sort((a,b)=> (b.confidence_pct - a.confidence_pct))
      .slice(0,3);

    return res.status(200).json({
      ok: true,
      slot, ymd,
      items: out,
      football: out,
      top3,
      source,
      policy_cap: 50,
      debug: { before, after: out.length, fallback_used: false }
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
