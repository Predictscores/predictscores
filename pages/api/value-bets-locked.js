// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

/* ---------- helpers: JSON & time ---------- */
const J = (s) => { try { return JSON.parse(String(s || "")); } catch { return null; } };

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
function isWeekendInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" });
  const wd = fmt.format(d); // "Sat" / "Sun" / ...
  return wd === "Sat" || wd === "Sun";
}

/* ---------- KV (REST) ---------- */
function kvBackends() {
  const out = [];
  const aU = (process.env.KV_REST_API_URL || "").replace(/\/+$/, ""), aT = (process.env.KV_REST_API_TOKEN || "").trim();
  const bU = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, ""), bT = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (aU && aT) out.push({ flavor: "vercel-kv", url: aU, tok: aT });
  if (bU && bT) out.push({ flavor: "upstash-redis", url: bU, tok: bT });
  return out;
}
async function kvGETraw(key, trace) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${b.tok}` }, cache: "no-store" });
      const ok = r.ok; const j = ok ? await r.json().catch(() => null) : null;
      const val = (j && typeof j.result === "string" && j.result) || null;
      trace && trace.push({ key, flavor: b.flavor, status: ok ? (val ? "hit" : "miss") : `http-${r.status}` });
      if (val) return { raw: val, flavor: b.flavor };
    } catch (e) {
      trace && trace.push({ key, flavor: b.flavor, status: `err:${String(e?.message || e)}` });
    }
  }
  return { raw: null, flavor: null };
}

/* ---------- parsing utils ---------- */
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
function kickoffFromMeta(it) {
  const s = it?.kickoff_utc || it?.kickoff || it?.datetime_local?.starting_at?.date_time || it?.fixture?.date || null;
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}
function confidence(it) {
  if (Number.isFinite(it?.confidence_pct)) return Number(it.confidence_pct);
  if (Number.isFinite(it?.model_prob)) return Math.round(100 * Number(it.model_prob));
  return 0;
}

/* ---------- env caps (safe) ---------- */
function numEnv(name, def) {
  const raw = (process.env[name] ?? "").toString().trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const CAP_LATE = () => numEnv("CAP_LATE", 6);
const CAP_AM_WD = () => numEnv("CAP_AM_WD", 15);
const CAP_PM_WD = () => numEnv("CAP_PM_WD", 15);
const CAP_AM_WE = () => numEnv("CAP_AM_WE", 20);
const CAP_PM_WE = () => numEnv("CAP_PM_WE", 20);
const LEAGUE_CAP = () => numEnv("LEAGUE_MAX_PER_LEAGUE", 2);
const UEFA_CAP = () => numEnv("LEAGUE_MAX_UEFA", 6);

function leagueKeyOf(it) {
  const id = Number(it?.league?.id ?? it?.league_id ?? 0) || 0;
  const name = (it?.league?.name || it?.league_name || "").toString().trim();
  return `${id}:${name}`;
}
function isUEFA(name) {
  const s = (name || "").toString().toLowerCase();
  return /champions league|europa league|uefa|conference league/.test(s);
}

function applyLeagueCaps(arr) {
  const out = [];
  const perLeague = new Map();
  for (const it of arr) {
    const lk = leagueKeyOf(it);
    const lname = lk.split(":")[1] || "";
    const cap = isUEFA(lname) ? UEFA_CAP() : LEAGUE_CAP();
    const n = perLeague.get(lk) || 0;
    if (n >= cap) continue;
    perLeague.set(lk, n + 1);
    out.push(it);
  }
  return out;
}

/* ---------- readers ---------- */
async function readItems(ymd, slot, trace, slotCap) {
  const strictKeys = [
    `vbl_full:${ymd}:${slot}`,
    `vbl:${ymd}:${slot}`,
    `vb:day:${ymd}:${slot}`,
  ];
  for (const k of strictKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const only = arr.filter(it => {
        const d = kickoffFromMeta(it); if (!d) return false;
        const h = hourInTZ(d, TZ);
        return (slot === "late" ? h < 10 : slot === "am" ? (h >= 10 && h < 15) : h >= 15);
      });
      if (only.length) {
        only.sort((a, b) => (confidence(b) - confidence(a)) || ((kickoffFromMeta(a)?.getTime() || 0) - (kickoffFromMeta(b)?.getTime() || 0)));
        const capped = applyLeagueCaps(only).slice(0, slotCap);
        return { items: capped, source: k, before: only.length, after: capped.length };
      }
    }
  }
  // fallback: union/last – samo da UI ne bude prazan (i ovde poštuj cap)
  const fallbackKeys = [`vb:day:${ymd}:union`, `vb:day:${ymd}:last`];
  for (const k of fallbackKeys) {
    const { raw } = await kvGETraw(k, trace);
    const arr = arrFromAny(J(raw));
    if (Array.isArray(arr) && arr.length) {
      const sorted = [...arr].sort((a, b) => (confidence(b) - confidence(a)) || ((kickoffFromMeta(a)?.getTime() || 0) - (kickoffFromMeta(b)?.getTime() || 0)));
      const capped = applyLeagueCaps(sorted).slice(0, slotCap);
      return { items: capped, source: k, before: arr.length, after: capped.length };
    }
  }
  return { items: [], source: null, before: 0, after: 0 };
}

async function readTickets(ymd, slot, trace) {
  const tried = [];
  const now = Date.now();
  const keep = (x) => ((kickoffFromMeta(x)?.getTime() || 0) > now);

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

  const sortT = (a, b) => (confidence(b) - confidence(a)) || ((kickoffFromMeta(a)?.getTime() || 0) - (kickoffFromMeta(b)?.getTime() || 0));
  return {
    tickets: {
      btts: (obj.btts || []).filter(keep).sort(sortT),
      ou25: (obj.ou25 || []).filter(keep).sort(sortT),
      htft: (obj.htft || []).filter(keep).sort(sortT),
    },
    source: src,
    tried
  };
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  const wantDebug = String(req.query?.debug || "") === "1" || String(req.query?.debug || "").toLowerCase() === "true";
  const trace = wantDebug ? [] : null;
  try {
    res.setHeader("Cache-Control", "no-store");

    const now = new Date();
    const ymd = (req.query?.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.ymd))) ? String(req.query.ymd) : ymdInTZ(now, TZ);
    const slot = (req.query?.slot && /^(am|pm|late)$/.test(String(req.query.slot))) ? String(req.query.slot) : deriveSlot(hourInTZ(now, TZ));
    const weekend = isWeekendInTZ(now, TZ);

    // slot cap (ENV)
    const slotCap =
      slot === "late" ? CAP_LATE() :
      weekend ? (slot === "am" ? CAP_AM_WE() : CAP_PM_WE()) :
                (slot === "am" ? CAP_AM_WD() : CAP_PM_WD());

    const { items, source, before, after } = await readItems(ymd, slot, trace, slotCap);
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
      slot_cap: slotCap,
      ...(wantDebug ? { debug: { trace, before, after, tickets_tried: ttried } } : {})
    };
    return res.status(200).json(payload);
  } catch (e) {
    // Nikad 500 bez poruke — vrati debug da odmah vidiš gde puca
    const msg = String(e?.message || e);
    if (wantDebug) {
      return res.status(200).json({ ok: false, error: msg, stack: e?.stack || null });
    }
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
}
