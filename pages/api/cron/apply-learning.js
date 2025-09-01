// pages/api/cron/apply-learning.js
// Svrha: popuni istoriju za learning iz "locked" feed-a.
// Ako nema vb:day:<YMD>:<slot>, kopira iz vbl:<YMD>:<slot> (ili aliasa) i upisuje:
//   - vb:day:<YMD>:<slot>  (DIREKTNA LISTA predloga kao niz)
//   - hist:<YMD>:<slot>    (snapshot za learn)
//   - hist:index           (indeks YMD-ova, max 90, ultra-safe update)
// NOTE: vb:day:<YMD>:last upisuje listu SAMO ako pointer ne postoji (kompatibilno sa rebuild.js).
//
// Poziv: bez parametara (danas, sva tri slota) ili ?ymd=YYYY-MM-DD&slot=am|pm|late ili ?days=N
// Debug: ?debug=1 -> response ubacuje dijagnostiku šta je nađeno i šta je pisano.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const qDays = toInt(req.query?.days, 0);
    const qYMD = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));
    const qSlot = normalizeSlot(String(req.query?.slot || "") || "");
    const wantDebug = String(req.query?.debug || "") === "1";

    const processed = [];
    let totalWritten = 0;

    if (qDays && qDays > 0) {
      for (let d = 0; d < qDays; d++) {
        const ymd = ymdMinusDays(qYMD, d);
        const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
        for (const slot of slots) {
          const info = await ensureDaySlot(ymd, slot, wantDebug);
          processed.push(info);
          if (info.wrote) totalWritten++;
        }
      }
      return res.status(200).json(
        wantDebug
          ? { ok: true, days: qDays, count_written: totalWritten, processed }
          : { ok: true, days: qDays, count_written: totalWritten, processed: processed.map(x => ({ ymd: x.ymd, slot: x.slot, wrote: x.wrote })) }
      );
    }

    const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
    for (const slot of slots) {
      const info = await ensureDaySlot(qYMD, slot, wantDebug);
      processed.push(info);
      if (info.wrote) totalWritten++;
    }

    return res.status(200).json(
      wantDebug
        ? { ok: true, ymd: qYMD, count_written: totalWritten, processed }
        : { ok: true, ymd: qYMD, count_written: totalWritten, processed: processed.map(x => ({ ymd: x.ymd, slot: x.slot, wrote: x.wrote })) }
    );
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

async function ensureDaySlot(ymd, slot, wantDebug=false) {
  const info = { ymd, slot, wrote: false, reason: "", source_key: null, counts: {}, exist_vb_day_len: 0 };

  // 1) već postoji direktna lista?
  const existingRaw = await kvGet(`vb:day:${ymd}:${slot}`);
  const existing = ensureArray(existingRaw);
  info.exist_vb_day_len = existing.length;
  if (existing.length) {
    info.reason = "vb:day already exists";
    return info;
  }

  // 2) probaj da nađeš locked payload (više ključeva, sa prebrojavanjem)
  const keys = [
    `vbl:${ymd}:${slot}`,
    `vb-locked:${ymd}:${slot}`,
    `vb:locked:${ymd}:${slot}`,
    `locked:vbl:${ymd}:${slot}`,
    `vbl_full:${ymd}:${slot}`
  ];

  let pickedArr = [];
  for (const k of keys) {
    const v = await kvGet(k);
    const arr = ensureArray(v);
    info.counts[k] = Array.isArray(arr) ? arr.length : 0;
    if (!pickedArr.length && arr.length) {
      pickedArr = arr;
      info.source_key = k;
    }
  }

  if (!pickedArr.length) {
    info.reason = "no locked key found (or empty)";
    return info;
  }

  // 3) upiši direktnu LISTU (ne pointer/objekat)
  const json = JSON.stringify(pickedArr);
  await kvSet(`vb:day:${ymd}:${slot}`, json);
  await kvSet(`hist:${ymd}:${slot}`, json);

  // 3a) vb:day:<ymd>:last — upiši listu SAMO ako pointer ne postoji
  const lastRaw = await kvGet(`vb:day:${ymd}:last`);
  if (shouldWriteLastAsList(lastRaw)) {
    await kvSet(`vb:day:${ymd}:last`, json);
  }

  // 4) ultra-safe ažuriranje hist:index (nikad ne puca)
  try {
    const idxRaw = await kvGet(`hist:index`);
    const prev = parseIndexArray(idxRaw);                  // uvek niz
    const filtered = prev.filter(d => d !== ymd);          // uvek niz
    const newIdx = [ymd].concat(filtered).slice(0, 90);    // bez spread-a
    await kvSet(`hist:index`, JSON.stringify(newIdx));
    info.hist_index = { before_len: prev.length, after_len: newIdx.length };
  } catch (e) {
    info.hist_index_error = String(e?.message || e);
  }

  // 5) markeri (opciono)
  await kvSet(`vb:last:${slot}`, JSON.stringify({ ymd, slot, count: pickedArr.length, at: new Date().toISOString() }));

  info.wrote = true;
  info.copied_len = pickedArr.length;
  return info;
}

function shouldWriteLastAsList(raw){
  if (!raw) return true; // nema ničega — slobodno napiši listu
  try{
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    const looksPointer = !!(v && !Array.isArray(v) && (v.key || v.alt));
    if (looksPointer) return false;
    const listy = Array.isArray(v) ||
                  Array.isArray(v?.items) ||
                  Array.isArray(v?.football) ||
                  Array.isArray(v?.value_bets);
    return listy;
  }catch{
    return false; // ako ne možemo da parsiramo, ne diraj
  }
}

function parseIndexArray(raw){
  try{
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(x => typeof x === "string");
    if (typeof raw === "string") {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(x => typeof x === "string") : [];
    }
    // ponekad backend vraća {result: "..."} već raspakovano — treat as empty
    if (typeof raw === "object") {
      // dozvoli i varijante { value: "[]"} itd.
      if (typeof raw.value === "string") {
        try {
          const v = JSON.parse(raw.value);
          return Array.isArray(v) ? v.filter(x => typeof x === "string") : [];
        } catch { return []; }
      }
      return [];
    }
    return [];
  }catch{
    return [];
  }
}

// --- helpers: locked list ---
function ensureArray(v) {
  try {
    if (v == null) return [];
    if (Array.isArray(v)) return v;

    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return [];
      const parsed = JSON.parse(s);
      return ensureArray(parsed);
    }
    if (typeof v === "object") {
      // najčešći formati payload-a:
      if (Array.isArray(v.items)) return v.items;
      if (Array.isArray(v.football)) return v.football;
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.valueBets)) return v.valueBets;

      // generički "array-like" polja
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;

      // ako value izgleda kao JSON-string niza
      if (typeof v.value === "string") {
        try {
          const p = JSON.parse(v.value);
          if (Array.isArray(p)) return p;
        } catch {}
      }
      return [];
    }
    return [];
  } catch {
    return [];
  }
}

// --- KV ---
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && j.result != null ? j.result : null;
  } catch {
    return null;
  }
}
async function kvSet(key, valueJSON) {
  if (!KV_URL || !KV_TOKEN) return false;
  // prefer JSON body
  let r = await fetch(`${KV_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ value: valueJSON }),
  }).catch(()=>null);
  if (r && r.ok) return true;
  // fallback path
  r = await fetch(`${KV_URL.replace(/\/+$/, "")}/set/${encodeURIComponent(key)}/${encodeURIComponent(valueJSON)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  }).catch(()=>null);
  return !!(r && r.ok);
}

// --- time utils ---
function ymdInTZ(d = new Date(), tz = TZ) {
  try{
    const fmt = new Intl.DateTimeFormat("sv-SE",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
    return `${p.year}-${p.month}-${p.day}`;
  }catch{
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function normalizeYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdInTZ(new Date(), TZ);
}
function ymdMinusDays(ymd, daysBack) {
  try {
    const [Y, M, D] = ymd.split("-").map((n) => parseInt(n, 10));
    const d = new Date(Date.UTC(Y, (M - 1), D, 12, 0, 0));
    d.setUTCDate(d.getUTCDate() - daysBack);
    return ymdInTZ(d, TZ);
  } catch {
    return ymd;
  }
}
function normalizeSlot(s) {
  const x = String(s || "").toLowerCase();
  return ["am", "pm", "late"].includes(x) ? x : "";
}
function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}
