// =============================================
// Locked snapshot + Smart overlay (floats, cap per league, dynamic limit)
// Bez crona: overlay se pali na saobraćaj, sa cooldown-om i SETNX lock-om
// Env (sve opcione osim KV):
//   KV_REST_API_URL, KV_REST_API_TOKEN
//   TZ_DISPLAY=Europe/Belgrade
//   VB_LIMIT=25 (fallback), VB_LIMIT_WEEKDAY=15, VB_LIMIT_WEEKEND=25
//   VB_MAX_PER_LEAGUE=2
//   SMART45_FLOAT_ENABLED=1
//   SMART45_FLOAT_TOPK=8
//   SMART45_FLOAT_COOLDOWN_GLOBAL=900    (sekundi; npr. 15 min)
//   SMART45_FLOAT_COOLDOWN_FIXTURE=1800  (sekundi; npr. 30 min)
//   UEFA_LEAGUE_IDS="2,3,4"  (CSV; opciono za izuzetak cap-a)
// =============================================

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const VB_LIMIT_FALLBACK = parseInt(process.env.VB_LIMIT || "25", 10);
const VB_LIMIT_WEEKDAY = parseInt(process.env.VB_LIMIT_WEEKDAY || "15", 10);
const VB_LIMIT_WEEKEND = parseInt(process.env.VB_LIMIT_WEEKEND || "25", 10);
const VB_MAX_PER_LEAGUE = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);

const FLOATS_ENABLED = process.env.SMART45_FLOAT_ENABLED === "1";
const FLOATS_TOPK = parseInt(process.env.SMART45_FLOAT_TOPK || "8", 10);
const CD_GLOBAL = parseInt(process.env.SMART45_FLOAT_COOLDOWN_GLOBAL || "900", 10);
const CD_FIXTURE = parseInt(process.env.SMART45_FLOAT_COOLDOWN_FIXTURE || "1800", 10);

const UEFA_IDS = (process.env.UEFA_LEAGUE_IDS || "")
  .split(",")
  .map(s => parseInt(s.trim(), 10))
  .filter(n => Number.isFinite(n));

function ymdTZ(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return f.format(d); // YYYY-MM-DD
}
function dayOfWeekTZ(d = new Date()) {
  // 0=Sunday .. 6=Saturday u 'en-GB'
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short" });
  const short = f.format(d).toLowerCase(); // sun, mon, ...
  const map = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  return map[short] ?? 0;
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function maskErr(e) {
  try { return String(e?.message || e); } catch { return "unknown"; }
}

// unwrap Upstash get result (može da vrati string JSON sa {value, ex})
function unwrapKV(raw) {
  let v = raw;
  try {
    if (typeof v === "string") {
      const p = JSON.parse(v);
      if (p && typeof p === "object" && "value" in p) {
        v = p.value;
      } else {
        v = p;
      }
    }
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
      v = JSON.parse(v);
    }
  } catch {}
  return v;
}
async function kvGet(key) {
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
  } catch {
    return null;
  }
}
async function kvSet(key, value, opts = {}) {
  try {
    const body = {
      value: typeof value === "string" ? value : JSON.stringify(value),
    };
    if (opts.ex) body.ex = opts.ex;   // TTL sec
    if (opts.nx) body.nx = true;      // SETNX
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KV_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function leagueCapFilter(list, maxPerLeague = 2, uefaIds = []) {
  if (!Array.isArray(list) || maxPerLeague <= 0) return list || [];
  const perLeague = new Map();
  const out = [];
  for (const it of list) {
    const lgId = it?.league?.id;
    const isUEFA = uefaIds.includes(parseInt(lgId, 10));
    if (isUEFA) {
      out.push(it);
      continue;
    }
    const cnt = perLeague.get(lgId) || 0;
    if (cnt < maxPerLeague) {
      out.push(it);
      perLeague.set(lgId, cnt + 1);
    }
  }
  return out;
}

// lagani overlay korektor confidence-a baziran na floats (odds drift + near KO)
function applyAdjustedConfidence(item, live) {
  const base = typeof item?.confidence_pct === "number" ? item.confidence_pct : null;
  if (base == null) return null;

  let adj = base;
  const why = [];

  if (typeof live?.movement_pct === "number") {
    if (live.movement_pct >= 1.5) { adj += 1; why.push("+1pp drift ≥ +1.5%"); }
    if (live.movement_pct <= -1.5) { adj -= 1; why.push("-1pp drift ≤ -1.5%"); }
  }
  if (typeof live?.bookmakers_count === "number" && live.bookmakers_count >= 4) {
    // blagi boost ako ima dovoljno bukija i meč je skor
    try {
      const dt = item?.datetime_local?.starting_at?.date_time;
      if (dt) {
        const start = new Date(dt);
        const now = new Date();
        const mins = Math.floor((start - now) / 60000);
        if (mins <= 120) { adj += 1; why.push("+1pp KO ≤ 120m & bookies ≥ 4"); }
      }
    } catch {}
  }

  adj = clamp(adj, 38, 65);

  return { confidence_pct: adj, why };
}

// izračunaj „floats“ metrika vs snapshot (market_odds)
function buildLiveFromCurrent(snapshotItem, currentItem) {
  if (!snapshotItem || !currentItem) return null;
  const snapOdds = Number(snapshotItem.market_odds);
  const curOdds  = Number(currentItem.market_odds);
  if (!Number.isFinite(snapOdds) || !Number.isFinite(curOdds)) return null;

  const movement_pct = ((curOdds - snapOdds) / snapOdds) * 100; // + znači „bolja“ kvota
  const implied_prob = Number(currentItem.implied_prob ?? (1 / curOdds));
  const ev = Number(currentItem.ev ?? (currentItem.model_prob ? (currentItem.model_prob - (1 / curOdds)) : null));

  return {
    odds: curOdds,
    implied_prob,
    ev,
    bookmakers_count: Number(currentItem.bookmakers_count ?? snapshotItem.bookmakers_count ?? 0),
    movement_pct,
    ts: new Date().toISOString(),
  };
}

// pozadinski light refresh: pročitaj /api/value-bets i upiši floats za topK mečeva (sa cooldown-om)
async function backgroundRefreshFloats(req, topList) {
  if (!FLOATS_ENABLED || !Array.isArray(topList) || topList.length === 0) return;

  const today = ymdTZ();
  const globalKey = `smart45:float:cooldown:${today}`;
  const setOK = await kvSet(globalKey, "1", { nx: true, ex: CD_GLOBAL });
  if (!setOK) return; // global cooldown je aktivan

  try {
    const proto = req.headers["x-forwarded-proto"] || (req.headers["x-forwarded-protocol"] || "https");
    const host  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-hostname"] || req.headers.host;
    const base  = `${proto}://${host}`;

    // povuci trenutnu listu (generator) – filtriraćemo samo potrebne fixture_id
    const r = await fetch(`${base}/api/value-bets`, { cache: "no-store" });
    const payload = await r.json().catch(() => ({}));
    const pool = Array.isArray(payload?.value_bets) ? payload.value_bets
               : Array.isArray(payload) ? payload : [];

    const byId = new Map(pool.map(x => [x.fixture_id, x]));
    const slice = topList.slice(0, FLOATS_TOPK);

    for (const it of slice) {
      const fx = it?.fixture_id;
      if (!fx) continue;

      const fixKey = `smart45:float:fx:${fx}`;
      const lockOK = await kvSet(fixKey, "1", { nx: true, ex: CD_FIXTURE });
      if (!lockOK) continue; // fixture cooldown

      const cur = byId.get(fx);
      const live = buildLiveFromCurrent(it, cur);
      if (!live) continue;

      await kvSet(`vb:float:${fx}`, live, { ex: Math.max(2 * 3600, CD_FIXTURE) }); // 2h+ TTL
    }
  } catch {}
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const today = ymdTZ();
    const dow = dayOfWeekTZ();
    const vbLimitDynamic = (dow === 0 || dow === 6) ? VB_LIMIT_WEEKEND : VB_LIMIT_WEEKDAY; // ned=0, sub=6
    const VB_LIMIT_FINAL = Number.isFinite(vbLimitDynamic) ? vbLimitDynamic : VB_LIMIT_FALLBACK;

    // 1) last snapshot
    let snapshot = await kvGet(`vb:day:${today}:last`);
    let source = "locked-cache";

    // 2) fallback preko rev pointera ako nema last
    if (!snapshot || (Array.isArray(snapshot) && snapshot.length === 0) || (snapshot && !snapshot.value_bets)) {
      const revRaw = await kvGet(`vb:day:${today}:rev`);
      const rev = parseInt(typeof revRaw === "number" ? String(revRaw) : (revRaw || "").toString(), 10);
      if (Number.isFinite(rev) && rev > 0) {
        const snap2 = await kvGet(`vb:day:${today}:rev:${rev}`);
        if (snap2 && (Array.isArray(snap2) || snap2.value_bets)) {
          snapshot = snap2;
          source = "locked-rev";
        }
      }
    }

    // 3) ako i dalje nema – self-heal posle 10:00 (isto kao ranije)
    if (!snapshot || (!Array.isArray(snapshot) && !Array.isArray(snapshot?.value_bets))) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date()).reduce((a, p) => ((a[p.type] = p.value), a), {});
      const hour = parseInt(parts.hour, 10);
      if (hour >= 10) {
        const cdKey = `vb:ensure:cooldown:${today}`;
        const setOK = await kvSet(cdKey, "1", { nx: true, ex: 8 * 60 });
        if (setOK) {
          const proto = req.headers["x-forwarded-proto"] || (req.headers["x-forwarded-protocol"] || "https");
          const host  = req.headers["x-forwarded-host"] || req.headers["x-forwarded-hostname"] || req.headers.host;
          const base  = `${proto}://${host}`;
          fetch(`${base}/api/cron/rebuild`).catch(() => {});
          return res.status(200).json({ value_bets: [], built_at: new Date().toISOString(), day: today, source: "ensure-started" });
        }
      }
      return res.status(200).json({ value_bets: [], built_at: new Date().toISOString(), day: today, source: "ensure-wait" });
    }

    // 4) uzmi listu iz snapshot-a (radi i ako snapshot već jeste niz)
    const listRaw = Array.isArray(snapshot) ? snapshot : (snapshot.value_bets || []);
    // 4a) cap po ligi (max 2; UEFA izuzetak po želji)
    const capped = leagueCapFilter(listRaw, VB_MAX_PER_LEAGUE, UEFA_IDS);
    // 4b) iseckaj na dinamički VB_LIMIT
    const sliced = capped.slice(0, VB_LIMIT_FINAL);

    // 5) overlay floats: probaj da pročitaš već postojeće floats i napravi adjusted
    const withOverlay = [];
    for (const it of sliced) {
      const fx = it?.fixture_id;
      let live = null, adjusted = null;
      if (fx) {
        const lv = await kvGet(`vb:float:${fx}`);
        if (lv) {
          live = lv;
          adjusted = applyAdjustedConfidence(it, live);
        }
      }
      withOverlay.push(live ? { ...it, live, adjusted } : it);
    }

    // 6) pozadinski refresh floats za TOPK (bez čekanja odgovora)
    backgroundRefreshFloats(req, sliced).catch(() => {});

    return res.status(200).json({
      value_bets: withOverlay,
      built_at: new Date().toISOString(),
      day: today,
      source,
      meta: {
        limit_applied: VB_LIMIT_FINAL,
        league_cap: VB_MAX_PER_LEAGUE,
        floats_enabled: FLOATS_ENABLED,
      },
    });
  } catch (e) {
    return res.status(200).json({
      value_bets: [],
      built_at: new Date().toISOString(),
      day: ymdTZ(),
      source: "error",
      error: maskErr(e),
    });
  }
}
