// pages/api/value-bets-locked.js
import {} from "url"; // drži ES module sintaksu u Next okruženju

export const config = { api: { bodyParser: false } };

/* ---------------- constants ---------------- */
const TZ = "Europe/Belgrade";
const UI_GRACE_MIN = Math.max(0, Number(process.env.UI_GRACE_MINUTES || 5) || 5); // min pre/posle kickoffa
// slot caps (radni dan / vikend)
const CAP_LATE   = Math.max(1, Number(process.env.CAP_LATE   || 6)  || 6);
const CAP_AM_WD  = Math.max(1, Number(process.env.CAP_AM_WD  || 15) || 15);
const CAP_PM_WD  = Math.max(1, Number(process.env.CAP_PM_WD  || 15) || 15);
const CAP_AM_WE  = Math.max(1, Number(process.env.CAP_AM_WE  || 20) || 20);
const CAP_PM_WE  = Math.max(1, Number(process.env.CAP_PM_WE  || 20) || 20);

/* ---------------- KV (REST) ---------------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU.replace(/\/+$/, ""), tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU.replace(/\/+$/, ""), tok: bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${b.tok}` },
        cache: "no-store",
      });
      const ok = r.ok;
      const j = ok ? await r.json().catch(() => null) : null;
      const val = (typeof j?.result === "string" && j.result) ? j.result : null;
      trace && trace.push({ key, flavor: b.flavor, status: ok ? (val ? "hit" : "miss") : `http-${r.status}` });
      if (val) return { raw: val, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ key, flavor: b.flavor, status: `err:${String(e?.message || e)}` });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------------- utils ---------------- */
const J = s => { try { return JSON.parse(String(s || "")); } catch { return null; } };
function arrFromAny(x) {
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object") {
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value === "string") { const v = J(x.value); if (Array.isArray(v)) return v; if (v && typeof v === "object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data)) return x.data;
    if (Array.isArray(x.list)) return x.list;
  }
  if (typeof x === "string") { const v = J(x); if (Array.isArray(v)) return v; if (v && typeof v === "object") return arrFromAny(v); }
  return null;
}
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const p = fmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false });
  return parseInt(fmt.format(d), 10);
}
function deriveSlot(h) { if (h < 10) return "late"; if (h < 15) return "am"; return "pm"; }
function isWeekend(d = new Date(), tz = TZ) {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  return wd === "Sat" || wd === "Sun";
}
function slotCap(slot, d = new Date(), tz = TZ) {
  const we = isWeekend(d, tz);
  if (slot === "late") return CAP_LATE;
  if (slot === "am")   return we ? CAP_AM_WE : CAP_AM_WD;
  return we ? CAP_PM_WE : CAP_PM_WD;
}
function kickoffFromMeta(it) {
  const s =
    it?.kickoff_utc ||
    it?.kickoff ||
    it?.datetime_local?.starting_at?.date_time ||
    it?.fixture?.date || null;
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}
function confidence(it) {
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob)) return Math.round(100 * Number(it.model_prob));
  return 0;
}

/* ---------------- item reader (1X2) ---------------- */
async function readItems(ymd, slot, cap, trace, wantSlim) {
  const timeOk = (d) => {
    const h = hourInTZ(d, TZ);
    return (slot === "late" ? h < 10 : slot === "am" ? (h >= 10 && h < 15) : h >= 15);
  };
  const sorter = (a, b) =>
    (confidence(b) - confidence(a)) ||
    ((kickoffFromMeta(a)?.getTime() || 0) - (kickoffFromMeta(b)?.getTime() || 0));

  // 1) striktno po slotu
  const strictKeys = [
    `vbl_full:${ymd}:${slot}`,
    `vbl:${ymd}:${slot}`,
    `vb:day:${ymd}:${slot}`,
  ];
  for (const k of strictKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const only = arr.filter((it) => { const d = kickoffFromMeta(it); return d && timeOk(d); }).sort(sorter);
      if (only.length) {
        const list = wantSlim ? only.slice(0, cap) : only;
        return { items: list, source: k, before: arr.length, after: list.length };
      }
    }
  }

  // 2) fallback: UNION / LAST (da UI ne ostane prazan)
  const fallbackKeys = [`vb:day:${ymd}:union`, `vb:day:${ymd}:last`];
  for (const k of fallbackKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const list = arr
        .filter((it) => { const d = kickoffFromMeta(it); return d && timeOk(d); })
        .sort(sorter)
        .slice(0, cap);
      return { items: list, source: k, before: arr.length, after: list.length };
    }
  }

  return { items: [], source: null, before: 0, after: 0 };
}

/* ---------------- tickets reader (BTTS / OU2.5 / HTFT) ---------------- */
async function readTickets(ymd, slot, trace) {
  const tried = [];
  const nowMs = Date.now();
  const graceMs = UI_GRACE_MIN * 60 * 1000;

  const kickoffMs = (x) => kickoffFromMeta(x)?.getTime() || 0;
  const keep = (x) => kickoffMs(x) >= (nowMs - graceMs); // dozvoli male prekoračaje

  const slotKey = `tickets:${ymd}:${slot}`;
  const { raw: rawSlot } = await kvGETraw(slotKey, tried);
  let obj = J(rawSlot);
  let src = obj ? slotKey : null;

  if (!obj || typeof obj !== "object") {
    const dayKey = `tickets:${ymd}`;
    const { raw: rawDay } = await kvGETraw(dayKey, tried);
    obj = J(rawDay);
    if (obj) src = dayKey;
  }
  if (!obj) return { tickets: { btts: [], ou25: [], htft: [] }, source: src, tried };

  const sortT = (a, b) =>
    (confidence(b) - confidence(a)) ||
    (kickoffMs(a) - kickoffMs(b));

  return {
    tickets: {
      btts: (obj.btts || []).filter(keep).sort(sortT),
      ou25: (obj.ou25 || []).filter(keep).sort(sortT),
      htft: (obj.htft || []).filter(keep).sort(sortT),
    },
    source: src,
    tried,
  };
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const q = req.query || {};
    const now = new Date();
    const ymd = String(q.ymd || "").trim() || ymdInTZ(now, TZ);
    const slot = (String(q.slot || "").trim().toLowerCase() || deriveSlot(hourInTZ(now, TZ)));
    const wantDebug = String(q.debug || "") === "1" || String(q.debug || "").toLowerCase() === "true";
    const wantSlim = String(q.slim || "") === "1";
    const trace = wantDebug ? [] : null;

    const cap = slotCap(slot, now, TZ);

    const { items, source, before, after } = await readItems(ymd, slot, cap, trace, wantSlim);
    const { tickets, source: tsrc, tried: ttried } = await readTickets(ymd, slot, trace);

    const payload = {
      ok: true,
      slot,
      ymd,
      items,
      football: items,
      top3: items.slice(0, 3),
      tickets,
      source,
      tickets_source: tsrc,
      policy_cap: 15,
      slot_cap: cap,
      ...(wantDebug ? { debug: { trace, before, after, tickets_tried: ttried } } : {}),
    };
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
