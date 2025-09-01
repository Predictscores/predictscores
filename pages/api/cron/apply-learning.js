// pages/api/cron/apply-learning.js
// Svrha: popuni istoriju za learning iz "locked" feed-a.
// Ako nema vb:day:<YMD>:<slot>, kopira iz vbl:<YMD>:<slot> (ili drugih aliasa) i upisuje:
//   - vb:day:<YMD>:<slot>  (DIREKTNA LISTA predloga kao niz)
//   - hist:<YMD>:<slot>    (snapshot za learn)
//   - hist:index           (indeks YMD-ova, max 90)
// NOTE: vb:day:<YMD>:last upisuje SAMO ako već ne postoji pointer objekat {key, alt}.
//
// Poziv: bez parametara (danas, sva tri slota) ili ?ymd=YYYY-MM-DD&slot=am|pm|late ili ?days=N

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const qDays = toInt(req.query?.days, 0);
    const qYMD = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));
    const qSlot = normalizeSlot(String(req.query?.slot || "") || "");

    let totalWritten = 0;
    const processed = [];

    if (qDays && qDays > 0) {
      for (let d = 0; d < qDays; d++) {
        const ymd = ymdMinusDays(qYMD, d);
        const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
        for (const slot of slots) {
          const wrote = await ensureDaySlot(ymd, slot);
          processed.push({ ymd, slot, wrote });
          if (wrote) totalWritten++;
        }
      }
      return res.status(200).json({ ok: true, days: qDays, count_written: totalWritten, processed });
    }

    const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
    for (const slot of slots) {
      const wrote = await ensureDaySlot(qYMD, slot);
      processed.push({ ymd: qYMD, slot, wrote });
      if (wrote) totalWritten++;
    }

    return res.status(200).json({ ok: true, ymd: qYMD, count_written: totalWritten, processed });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

async function ensureDaySlot(ymd, slot) {
  // 1) već postoji direktna lista?
  const existing = ensureArray(await kvGet(`vb:day:${ymd}:${slot}`));
  if (existing.length) return false;

  // 2) probaj da pročitaš locked payload (više ključeva)
  const arr = await readLockedList(ymd, slot);
  if (!arr.length) return false;

  // 3) upiši direktnu LISTU (ne pointer/objekat)
  await kvSet(`vb:day:${ymd}:${slot}`, JSON.stringify(arr));
  await kvSet(`hist:${ymd}:${slot}`, JSON.stringify(arr));

  // 3a) vb:day:<ymd>:last — upiši listu SAMO ako pointer ne postoji
  const lastRaw = await kvGet(`vb:day:${ymd}:last`);
  if (shouldWriteLastAsList(lastRaw)) {
    await kvSet(`vb:day:${ymd}:last`, JSON.stringify(arr));
  }

  // 4) ažuriraj indeks poslednjih dana (max 90)
  const idxRaw = await kvGet(`hist:index`);
  let idxArr = [];
  try {
    idxArr = Array.isArray(idxRaw) ? idxRaw : (typeof idxRaw === "string" ? JSON.parse(idxRaw) : []);
  } catch {}
  const newIdx = [ymd, ...((idxArr || []).filter(d => d !== ymd))].slice(0, 90);
  await kvSet(`hist:index`, JSON.stringify(newIdx));

  // 5) markeri (opciono)
  await kvSet(`vb:last:${slot}`, JSON.stringify({ ymd, slot, count: arr.length, at: new Date().toISOString() }));

  return true;
}

function shouldWriteLastAsList(raw){
  if (!raw) return true; // nema ničega — slobodno napiši listu
  try{
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;

    // Ako izgleda kao pointer objekat { key, alt }, NE diraj.
    const looksPointer = !!(v && !Array.isArray(v) && (v.key || v.alt));
    if (looksPointer) return false;

    // Ako je već lista (ili objekat sa items/football/value_bets), možeš prepisati listom.
    const listy = Array.isArray(v) ||
                  Array.isArray(v?.items) ||
                  Array.isArray(v?.football) ||
                  Array.isArray(v?.value_bets);
    return listy;
  }catch{
    // Ako ne možemo da parsiramo, radije NEMOJ prepisivati.
    return false;
  }
}

// --- helpers: locked list ---
async function readLockedList(ymd, slot){
  const keys = [
    `vbl:${ymd}:${slot}`,
    `vb-locked:${ymd}:${slot}`,
    `vb:locked:${ymd}:${slot}`,
    `locked:vbl:${ymd}:${slot}`,
    `vbl_full:${ymd}:${slot}`
  ];
  for (const k of keys){
    const v = await kvGet(k);
    const arr = ensureArray(v);
    if (arr.length) return arr;
  }
  return [];
}

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
