// pages/api/cron/apply-learning.js
// Svrha: popuni istoriju za learning iz "locked" feed-a" i održi HISTORY indeks koji UI koristi.
// Ako nema vb:day:<YMD>:<slot>, kopira iz vbl:<YMD>:<slot> (ili aliasa) i upiše:
//   - vb:day:<YMD>:<slot>        (direktna LISTA predloga kao niz)
// U SVAKOM SLUČAJU (bez obzira da li je postojalo ili ne), obezbedi:
//   - hist:<YMD>:<slot>          (snapshot za history/learn UI)
//   - hist:index                 (lista TAG-ova 'YYYY-MM-DD:slot', najnoviji prvi, max 90)
//
// Kompatibilno sa rebuild.js koji ponekad piše vb:day:<YMD>:last kao { key, alt } pointer.
// Ovu vrednost NE diramo.
//
// Parametri: bez parametara (danas sva tri slota) ili ?ymd=YYYY-MM-DD&slot=am|pm|late ili ?days=N
// Debug: ?debug=1 ubacuje dijagnostiku po slotu (izvorni ključ, dužine, itd.)

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const qDays = toInt(req.query?.days, 0);
    const qYMD  = normalizeYMD(String(req.query?.ymd || "") || ymdInTZ(new Date(), TZ));
    const qSlot = normalizeSlot(String(req.query?.slot || "") || "");
    const wantDebug = String(req.query?.debug || "") === "1";

    const processed = [];
    let totalWritten = 0;

    if (qDays && qDays > 0) {
      for (let d = 0; d < qDays; d++) {
        const ymd = ymdMinusDays(qYMD, d);
        const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
        for (const slot of slots) {
          const info = await ensureDaySlotAndHistory(ymd, slot, wantDebug);
          processed.push(info);
          if (info.vbday_written || info.hist_written || info.index_updated) totalWritten++;
        }
      }
      return res.status(200).json(
        wantDebug
          ? { ok: true, days: qDays, count_written: totalWritten, processed }
          : { ok: true, days: qDays, count_written: totalWritten, processed: processed.map(x => ({ ymd: x.ymd, slot: x.slot, wrote: !!(x.vbday_written || x.hist_written || x.index_updated) })) }
      );
    }

    const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
    for (const slot of slots) {
      const info = await ensureDaySlotAndHistory(qYMD, slot, wantDebug);
      processed.push(info);
      if (info.vbday_written || info.hist_written || info.index_updated) totalWritten++;
    }

    return res.status(200).json(
      wantDebug
        ? { ok: true, ymd: qYMD, count_written: totalWritten, processed }
        : { ok: true, ymd: qYMD, count_written: totalWritten, processed: processed.map(x => ({ ymd: x.ymd, slot: x.slot, wrote: !!(x.vbday_written || x.hist_written || x.index_updated) })) }
    );
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

async function ensureDaySlotAndHistory(ymd, slot, wantDebug=false) {
  const tag = `${ymd}:${slot}`;
  const info = {
    ymd, slot, tag,
    vbday_len: 0, vbday_written: false, vbday_source: null, vbday_reason: "",
    hist_len: 0, hist_written: false,
    index_before: 0, index_after: 0, index_updated: false,
    debug_locked_counts: {}
  };

  // 1) Pročitaj postojeći vb:day:<ymd>:<slot>
  const vbdayRaw = await kvGet(`vb:day:${ymd}:${slot}`);
  let vbday = ensureArray(vbdayRaw);
  info.vbday_len = vbday.length;

  if (!vbday.length) {
    // 2) Pokušaj iz locked payload-a (razni ključevi)
    const keys = [
      `vbl:${ymd}:${slot}`,
      `vb-locked:${ymd}:${slot}`,
      `vb:locked:${ymd}:${slot}`,
      `locked:vbl:${ymd}:${slot}`,
      `vbl_full:${ymd}:${slot}`
    ];
    for (const k of keys) {
      const v = await kvGet(k);
      const arr = ensureArray(v);
      if (wantDebug) info.debug_locked_counts[k] = Array.isArray(arr) ? arr.length : 0;
      if (!vbday.length && arr.length) {
        vbday = arr;
        info.vbday_source = k;
      }
    }
    // 2a) Ako smo našli izvor — upiši vb:day:<ymd>:<slot> kao DIREKTNU LISTU
    if (vbday.length) {
      await kvSet(`vb:day:${ymd}:${slot}`, JSON.stringify(vbday));
      info.vbday_written = true;
    } else {
      info.vbday_reason = "no vb:day and no locked source";
    }
  } else {
    info.vbday_reason = "vb:day already exists";
  }

  // 3) U SVAKOM SLUČAJU — obezbedi hist:<ymd>:<slot> snapshot (ako ne postoji)
  const histRaw = await kvGet(`hist:${tag}`);
  const histArr = ensureArray(histRaw);
  info.hist_len = histArr.length;
  if (!histArr.length && vbday.length) {
    await kvSet(`hist:${tag}`, JSON.stringify(vbday));
    info.hist_written = true;
  }

  // 3a) vb:day:<ymd>:last — upiši listu SAMO ako pointer ne postoji (kompat sa rebuild aliasima)
  const lastRaw = await kvGet(`vb:day:${ymd}:last`);
  if (shouldWriteLastAsList(lastRaw) && vbday.length) {
    await kvSet(`vb:day:${ymd}:last`, JSON.stringify(vbday));
  }

  // 4) Ultra-safe update hist:index — lista TAG-ova `YYYY-MM-DD:slot`
  const idxRaw = await kvGet(`hist:index`);
  const before = parseIndexTags(idxRaw);
  info.index_before = before.length;
  const after = pushTag(before, tag, 90);
  info.index_after = after.length;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await kvSet(`hist:index`, JSON.stringify(after));
    info.index_updated = true;
  }

  // 5) Marker
  if (vbday.length) {
    await kvSet(`vb:last:${slot}`, JSON.stringify({ ymd, slot, count: vbday.length, at: new Date().toISOString() }));
  }

  return info;
}

// --- helpers: hist:index (TAG lista) ---
function parseIndexTags(raw){
  try{
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(x => typeof x === "string" && x.includes(":"));
    if (typeof raw === "string") {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.includes(":")) : [];
    }
    if (typeof raw === "object" && typeof raw.value === "string") {
      try {
        const v = JSON.parse(raw.value);
        return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.includes(":")) : [];
      } catch { return []; }
    }
    return [];
  }catch{ return []; }
}
function pushTag(arr, tag, cap=90){
  const out = Array.isArray(arr) ? arr.filter(t => t !== tag) : [];
  out.unshift(tag);
  if (out.length > cap) out.length = cap;
  return out;
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

// --- generic array extraction ---
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

// --- KV minimal ---
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: "no-store",
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
