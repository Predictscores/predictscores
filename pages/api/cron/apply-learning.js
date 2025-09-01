// pages/api/cron/apply-learning.js
// Svrha: osiguraj da "learning/history" ZAUVEK imaju ulaz.
// Ako nema vb:day:<YMD>:<slot>, fallback na vbl:<YMD>:<slot> i upiši ga u vb:day:<YMD>:<slot>.
// (Ostatak learning pipeline-a u projektu može da koristi vb:day kao izvor.)
// Podržava poziv bez parametara (danas, sva tri slota) ili ?ymd=YYYY-MM-DD&slot=am|pm|late ili ?days=N.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const UP_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  try {
    const qYMD = normalizeYMD(req.query.ymd) || ymdInTZ(new Date(), TZ);
    const qSlot = normalizeSlot(req.query.slot);
    const qDays = Math.max(1, Math.min(31, toInt(req.query.days, 0)));

    const processed = [];
    let totalWritten = 0;

    // Ako je prosleđen ?days=N → uzmi sve dane [0..N-1] od qYMD unazad
    if (qDays > 1) {
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

    // Jedan dan (qYMD), jedan ili sva tri slota
    const slots = qSlot ? [qSlot] : ["am", "pm", "late"];
    for (const slot of slots) {
      const wrote = await ensureDaySlot(qYMD, slot);
      processed.push({ ymd: qYMD, slot, wrote });
      if (wrote) totalWritten++;
    }
    return res.status(200).json({ ok: true, ymd: qYMD, count_written: totalWritten, processed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

async function ensureDaySlot(ymd, slot) {
  // 1) postoji li vb:day:<ymd>:<slot> ?
  let day = await kvGet(`vb:day:${ymd}:${slot}`);
  let arr = ensureArray(day);
  if (arr.length) return false; // već postoji — ništa ne radi

  // 2) fallback na vbl:<ymd>:<slot>
  const vbl = await kvGet(`vbl:${ymd}:${slot}`);
  const items = ensureArray(vbl);
  if (!items.length) return false; // ni locked nema — nema šta da upišemo

  // 3) upiši u vb:day:<ymd>:<slot> (kao JSON string top-level niza)
  await kvSet(`vb:day:${ymd}:${slot}`, JSON.stringify(items));

  // 3a) upiši i "last" LISTU za taj dan (za report i learn build)
  await kvSet(`vb:day:${ymd}:last`, JSON.stringify(items));

  // 3b) upiši history snapshot kompatibilan sa /api/cron/learn
  await kvSet(`hist:${ymd}:${slot}`, JSON.stringify(items));
  const idxRaw = await kvGet(`hist:index`);
  let idxArr = [];
  try{
    idxArr = Array.isArray(idxRaw) ? idxRaw : (typeof idxRaw === "string" ? JSON.parse(idxRaw) : []);
  }catch{}
  const newIdx = [ymd, ...idxArr.filter(d => d !== ymd)].slice(0, 90);
  await kvSet(`hist:index`, JSON.stringify(newIdx));

  // 4) opcionalno zapamti "last" markere
  await kvSet(`vb:last:${slot}`, JSON.stringify({ ymd, slot, count: items.length, at: new Date().toISOString() }));

  return true;
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
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
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

async function kvGet(key) {
  // try KV first
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
        cache: "no-store",
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result;
      }
    } catch {}
  }
  // fallback Upstash
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UP_TOKEN}` }
      });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.result != null) return j.result;
      }
    } catch {}
  }
  return null;
}

async function kvSet(key, valueJSON) {
  // KV primary
  if (KV_URL && KV_TOKEN) {
    try {
      const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KV_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: valueJSON }),
      });
      if (r.ok) return true;
    } catch {}
  }
  // Upstash fallback
  if (UP_URL && UP_TOKEN) {
    try {
      const r = await fetch(`${UP_URL}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UP_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ value: valueJSON }),
      });
      if (r.ok) return true;
    } catch {}
  }
  return false;
}

function normalizeYMD(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}`;
}
function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    });
    const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth()+1).padStart(2,"0"), dd = String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function ymdMinusDays(ymd, daysBack) {
  try {
    const [y,m,d] = ymd.split("-").map(n=>parseInt(n,10));
    const dt = new Date(Date.UTC(y, m-1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() - daysBack);
    return ymdInTZ(dt, TZ);
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
