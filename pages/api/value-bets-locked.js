// FILE: pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const store = global.__VBETS_LOCK__ || (global.__VBETS_LOCK__ = {
  dayKey: null,
  builtAt: null,
  pinned: null,
  backup: null,
  raw: null,
  rev: 0,
});

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 15));
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2));

/* ---------------- helpers ---------------- */
function dayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}
function hmNow() {
  const fmt = new Intl.DateTimeFormat("sv-SE",{ timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false });
  return fmt.format(new Date()); // "HH:MM"
}
function nowISO(){ return new Date().toISOString(); }
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }
function setCDN(res, smax=600, swr=120){ res.setHeader("Cache-Control", `s-maxage=${smax}, stale-while-revalidate=${swr}`); }

function isUEFA(name = "") {
  const n = String(name).toLowerCase();
  return n.includes("champions league") || n.includes("europa league") || n.includes("conference league");
}
function filterFuture(arr=[]) {
  const now = Date.now();
  return arr.filter(x => {
    const iso = x?.datetime_local?.starting_at?.date_time;
    const t = parseISO(iso);
    return Number.isFinite(t) && t > now;
  });
}
function rankBase(arr = []) {
  return arr.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
    const s = (b._score||0) - (a._score||0);
    if (s) return s;
    const eA = Number.isFinite(a.edge_pp)?a.edge_pp:-999;
    const eB = Number.isFinite(b.edge_pp)?b.edge_pp:-999;
    if (eB !== eA) return eB - eA;
    return String(a.fixture_id||"").localeCompare(String(b.fixture_id||""));
  });
}
function capPerLeague(ranked, limit = LIMIT){
  const perLeague = new Map();
  const picked = [];
  const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();
  for (const p of ranked) {
    const lname = p?.league?.name || "";
    const key = keyOfLeague(p);
    if (!isUEFA(lname)) {
      const cnt = perLeague.get(key) || 0;
      if (cnt >= MAX_PER_LEAGUE) continue;
      perLeague.set(key, cnt + 1);
    }
    picked.push(p);
    if (picked.length >= limit) break;
  }
  return picked;
}

/* --------------- KV helpers --------------- */
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}

/* ---- internal generator (for fallback) ---- */
async function callInternalGenerator(req){
  try{
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const r = await fetch(`${origin}/api/value-bets`, {
      headers: { "x-internal": "1" }, // endpoint je interni
      // GET je ok; ako je kod ograničen na POST, promeni ovde na method:"POST"
    });
    if (!r.ok) return [];
    const j = await r.json().catch(()=>({}));
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
    return arr;
  }catch(_){ return []; }
}

/* --------------- main handler --------------- */
export default async function handler(req, res) {
  try {
    const today = dayKey();
    const hm = hmNow();
    const hour = Number(hm.split(":")[0] || 0);

    // reset preko noći
    if (store.dayKey && store.dayKey !== today) {
      store.dayKey = null; store.builtAt = null;
      store.pinned = null; store.backup = null; store.raw = null; store.rev = 0;
    }

    // probaj da učitaš snapshot iz KV ako ima noviji rev
    const kvRev = Number(await kvGet(`vb:day:${today}:rev`) || 0);
    if (kvRev && kvRev > (store.rev || 0)) {
      const snap = await kvGet(`vb:day:${today}:last`);
      const future = filterFuture(Array.isArray(snap)?snap:[]);
      const ranked = rankBase(future);
      const pinned = capPerLeague(ranked, LIMIT);

      store.dayKey = today;
      store.builtAt = nowISO();
      store.pinned = pinned;
      store.backup = ranked.filter(p => !pinned.includes(p)).slice(0, Math.max(LIMIT, 40));
      store.raw = future;
      store.rev = kvRev;
    }

    // PRE 10:00 → koristi preview ako postoji (nikad jučerašnje)
    if (hour < 10) {
      const prev = await kvGet(`vb:preview:${today}:last`);
      const future = filterFuture(Array.isArray(prev)?prev:[]);
      const ranked = rankBase(future);
      const limited = capPerLeague(ranked, Math.min(LIMIT, 6)); // mali feed rano ujutru
      setCDN(res);
      return res.status(200).json({
        value_bets: limited,
        built_at: nowISO(),
        day: today,
        source: "preview"
      });
    }

    // POSLE 10:00 → probaj iz store/KV…
    if (Array.isArray(store.pinned) && store.pinned.length) {
      setCDN(res);
      return res.status(200).json({
        value_bets: store.pinned.slice(0, LIMIT),
        built_at: store.builtAt,
        day: store.dayKey,
        rev: store.rev || 0,
        source: "locked-cache"
      });
    }

    // …ako i dalje nema ničega (nema snapshot-a u KV) → FALLBACK
    // ne zapisujemo u KV; samo da UI ne bude prazan
    const raw = await callInternalGenerator(req);
    const future = filterFuture(raw);
    const ranked = rankBase(future);

    // minimalno 3, maksimalno 6 u fallbacku
    const fallbackLimit = Math.max(3, Math.min(6, LIMIT));
    const picked = capPerLeague(ranked, fallbackLimit);

    setCDN(res);
    return res.status(200).json({
      value_bets: picked,
      built_at: nowISO(),
      day: today,
      rev: 0,
      source: "fallback"
    });
  } catch (e) {
    setCDN(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e?.message||e) });
  }
}
