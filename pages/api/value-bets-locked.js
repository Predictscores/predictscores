export const config = { api: { bodyParser: false } };

const store = global.__VBETS_LOCK__ || (global.__VBETS_LOCK__ = {
  dayKey: null, builtAt: null, pinned: null, backup: null, raw: null, rev: 0
});

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 25));
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2));

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}
function belgradeHM(d=new Date()){
  const fmt = new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
  return fmt.format(d);
}
function nowISO(){ return new Date().toISOString(); }
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }
function setCDNHeaders(res) {
  const S_MAXAGE = Number(process.env.CDN_SMAXAGE_SEC || 600);
  const SWR      = Number(process.env.CDN_STALE_SEC     || 120);
  res.setHeader("Cache-Control", `s-maxage=${S_MAXAGE}, stale-while-revalidate=${SWR}`);
}
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

// KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}
async function kvIncr(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 0;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(["INCR", key])
  }).catch(()=>null);
  const j = await r?.json().catch(()=>({}));
  return Number(j?.result||0);
}
async function kvSetNX(key, value, pxMs) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return true;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?nx=true&px=${pxMs}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(()=>null);
  const j = await r?.json().catch(()=>({}));
  return j?.result === "OK";
}
function getOrigin(req){
  const proto = req?.headers?.["x-forwarded-proto"] || "https";
  const host  = req?.headers?.host;
  return `${proto}://${host}`;
}

// soft-mode calibration helpers
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function adjConfidence(p, calib) {
  const base = Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null;
  if (base == null) return null;
  const mKey = (p.market_label || p.market || "").toLowerCase();
  const leagueName = String(p.league?.name||"").toLowerCase();
  let delta = 0;
  const marketDelta = Number(calib?.market?.[mKey]?.delta_pp ?? 0);
  const leagueDelta = Number(calib?.league?.[mKey]?.[leagueName]?.delta_vs_market_pp ?? 0);
  delta += clamp(marketDelta, -5, 5);
  delta += clamp(leagueDelta, -8, 8);
  return clamp(Math.round(base + delta), 1, 99);
}
function buildWhy(p, appliedDelta) {
  const edge = Number.isFinite(p.edge_pp) ? `${Math.round(p.edge_pp*10)/10}pp` : null;
  const mp = Number.isFinite(p.model_prob) ? Math.round(p.model_prob*100) : null;
  const imp = Number.isFinite(p.implied_prob) ? Math.round(p.implied_prob*100) : (Number.isFinite(p.market_odds) ? Math.round((1/p.market_odds)*100) : null);
  const bks = Number.isFinite(p.bookmakers_count) ? p.bookmakers_count : null;
  const drift = Number.isFinite(p.movement_pct) ? `${Math.round(p.movement_pct)}%` : "0%";
  const bits = [];
  if (edge!=null) bits.push(`EV +${edge}`);
  if (mp!=null && imp!=null) bits.push(`Model ${mp}% vs ${imp}%`);
  if (bks!=null) bits.push(`Bookies ${bks}`);
  bits.push(`Drift ${drift}`);
  if (Number.isFinite(appliedDelta) && appliedDelta!==0) {
    const s = appliedDelta>0?`+${appliedDelta}`:`${appliedDelta}`;
    bits.push(`Calib ${s}pp`);
  }
  return bits.join(" · ");
}

async function loadSnapshotFromKV(today) {
  const arr = await kvGet(`vb:day:${today}:last`);
  return Array.isArray(arr) ? arr : [];
}
async function loadPreviewFromKV(today) {
  const arr = await kvGet(`vb:preview:${today}:last`);
  return Array.isArray(arr) ? arr : [];
}

export default async function handler(req, res) {
  try {
    const today = beogradDayKey();
    const hm = belgradeHM();
    const hour = Number(hm.split(":")[0] || 0);

    if (store.dayKey && store.dayKey !== today) {
      store.dayKey = null; store.builtAt = null;
      store.pinned = null; store.backup = null; store.raw = null; store.rev = 0;
    }

    // LIVE reload po KV rev-u
    const kvRev = Number(await kvGet(`vb:day:${today}:rev`) || 0);
    if (kvRev && kvRev > (store.rev || 0)) {
      const fresh = await loadSnapshotFromKV(today);
      const future = filterFuture(fresh);
      const ranked = rankBase(future);

      const perLeague = new Map();
      const pinned = [];
      const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();
      for (const p of ranked) {
        const lname = p?.league?.name || "";
        const key = keyOfLeague(p);
        if (!isUEFA(lname)) {
          const cnt = perLeague.get(key) || 0;
          if (cnt >= MAX_PER_LEAGUE) continue;
          perLeague.set(key, cnt + 1);
        }
        pinned.push(p);
        if (pinned.length >= LIMIT) break;
      }

      store.dayKey = today;
      store.builtAt = nowISO();
      store.pinned = pinned;
      store.backup = ranked.filter(p => !pinned.includes(p)).slice(0, Math.max(LIMIT, 40));
      store.raw = future;
      store.rev = kvRev;
    }

    // PRE 10:00 – obavezno prikaži bar 3 (lazy-build preview ako ga nema)
    if (hour < 10) {
      const MIN_NIGHT = 3;
      const NIGHT_CAP = Math.min(LIMIT, 6);

      let preview = await loadPreviewFromKV(today);
      if (!Array.isArray(preview) || preview.length < MIN_NIGHT) {
        const locked = await kvSetNX(`lock:preview:build:${today}`, hm, 5 * 60 * 1000);
        if (locked) {
          await fetch(`${getOrigin(req)}/api/locked-floats?preview=1`, { headers: { "x-internal-cron": "1" } }).catch(()=>{});
        }
        preview = await loadPreviewFromKV(today);
      }

      const prevFuture = filterFuture(Array.isArray(preview) ? preview : []).slice(0, NIGHT_CAP);
      const calib = await kvGet("vb:learn:calib:latest");

      const enriched = [];
      for (const p of prevFuture) {
        const fl = await kvGet(`vb:float:${p.fixture_id}`);
        if (fl && Number.isFinite(fl.odds) && fl.odds > 0) {
          p.market_odds = fl.odds;
          p.implied_prob = Number.isFinite(fl.implied) ? fl.implied : (1/p.market_odds);
          if (Number.isFinite(fl.ev)) p.ev = fl.ev;
          if (Number.isFinite(fl.bookmakers_count)) p.bookmakers_count = fl.bookmakers_count;
          if (Number.isFinite(fl.movement_pct)) p.movement_pct = fl.movement_pct;
        } else if (!Number.isFinite(p.implied_prob) && Number.isFinite(p.market_odds) && p.market_odds>0) {
          p.implied_prob = 1 / p.market_odds;
        }

        const baseConf = Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null;
        const adjConf = adjConfidence(p, calib);
        if (adjConf != null) p.confidence_pct = adjConf;
        const appliedDelta = (adjConf!=null && baseConf!=null) ? (adjConf - baseConf) : 0;

        const ins = await kvGet(`vb:insight:${p.fixture_id}`);
        if (ins && ins.line) p._insight_line = ins.line;

        p.explain = { ...(p.explain||{}), summary: buildWhy(p, appliedDelta) };
        enriched.push(p);
      }

      setCDNHeaders(res);
      return res.status(200).json({
        value_bets: enriched,
        built_at: nowISO(),
        day: today,
        source: "preview"
      });
    }

    // POSLE 10:00 – locked snapshot
    if (!Array.isArray(store.pinned) || store.dayKey !== today) {
      const fresh = await loadSnapshotFromKV(today);
      const future = filterFuture(fresh);
      const ranked = rankBase(future);

      const perLeague = new Map();
      const pinned = [];
      const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();
      for (const p of ranked) {
        const lname = p?.league?.name || "";
        const key = keyOfLeague(p);
        if (!isUEFA(lname)) {
          const cnt = perLeague.get(key) || 0;
          if (cnt >= MAX_PER_LEAGUE) continue;
          perLeague.set(key, cnt + 1);
        }
        pinned.push(p);
        if (pinned.length >= LIMIT) break;
      }

      store.dayKey = today;
      store.builtAt = nowISO();
      store.pinned = pinned;
      store.backup = ranked.filter(p => !pinned.includes(p)).slice(0, Math.max(LIMIT, 40));
      store.raw = future;
      store.rev = Number(await kvGet(`vb:day:${today}:rev`) || 0);
    }

    const calib = await kvGet("vb:learn:calib:latest");
    const enriched = [];
    for (const p of (store.pinned||[]).slice(0, LIMIT)) {
      const fl = await kvGet(`vb:float:${p.fixture_id}`);
      if (fl && Number.isFinite(fl.odds) && fl.odds > 0) {
        p.market_odds = fl.odds;
        p.implied_prob = Number.isFinite(fl.implied) ? fl.implied : (1/p.market_odds);
        if (Number.isFinite(fl.ev)) p.ev = fl.ev;
        if (Number.isFinite(fl.bookmakers_count)) p.bookmakers_count = fl.bookmakers_count;
        if (Number.isFinite(fl.movement_pct)) p.movement_pct = fl.movement_pct;
      } else if (!Number.isFinite(p.implied_prob) && Number.isFinite(p.market_odds) && p.market_odds>0) {
        p.implied_prob = 1 / p.market_odds;
      }

      const baseConf = Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null;
      const adjConf = adjConfidence(p, calib);
      if (adjConf != null) p.confidence_pct = adjConf;
      const appliedDelta = (adjConf!=null && baseConf!=null) ? (adjConf - baseConf) : 0;

      const minsTo = (() => {
        const iso = p?.datetime_local?.starting_at?.date_time?.replace(" ","T");
        if (!iso) return null;
        return Math.round((new Date(iso).getTime() - Date.now())/60000);
      })();
      const mv = Number(p.movement_pct||0);
      if (minsTo!=null && minsTo<=240) {
        if (mv >= 1.5) p.confidence_pct = Math.min(99, (p.confidence_pct||0) + 1);
        if (mv <= -1.5) p.confidence_pct = Math.max(1, (p.confidence_pct||0) - 1);
        if (minsTo <= 120 && Number(p.bookmakers_count||0) >= ( (Number(hm.split(":")[0])>=10 && Number(hm.split(":")[0])<=21) ? 4 : 3 )) {
          p.confidence_pct = Math.min(99, (p.confidence_pct||0) + 1);
        }
      }

      const ins = await kvGet(`vb:insight:${p.fixture_id}`);
      if (ins && ins.line) p._insight_line = ins.line;

      p.explain = { ...(p.explain||{}), summary: buildWhy(p, appliedDelta) };
      enriched.push(p);
    }

    setCDNHeaders(res);
    return res.status(200).json({
      value_bets: enriched,
      built_at: store.builtAt,
      day: store.dayKey,
      rev: store.rev || 0,
      source: "locked-cache"
    });
  } catch (e) {
    setCDNHeaders(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e && e.message || e) });
  }
}
