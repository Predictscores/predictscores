// FILE: pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const store = global.__VBETS_LOCK__ || (global.__VBETS_LOCK__ = {
  dayKey: null,
  builtAt: null,
  pinned: null,   // array (limit)
  backup: null,   // array (next up to 40)
  raw: null,
});

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 15)); // dogovor: 15
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2)); // cap po ligi (osim UEFA)

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
}
function belgradeHour(d = new Date()) {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", hour12: false
  }).format(d);
  return Number(h);
}
function slotLabel() {
  const h = belgradeHour();
  return h < 13 ? "10" : "15"; // naša dva ciklusa
}
function nowISO(){ return new Date().toISOString(); }
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }

function setCDNHeaders(res) {
  const S_MAXAGE = Number(process.env.CDN_SMAXAGE_SEC || 600); // 10 min
  const SWR      = Number(process.env.CDN_STALE_SEC     || 120);
  res.setHeader("Cache-Control", `s-maxage=${S_MAXAGE}, stale-while-revalidate=${SWR}`);
}

function rankBets(arr = []) {
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

function filterFuture(arr=[]) {
  const now = Date.now();
  return arr.filter(x => {
    const iso = x?.datetime_local?.starting_at?.date_time;
    const t = parseISO(iso);
    return Number.isFinite(t) && t > now;
  });
}

// UEFA izuzeci: Champions / Europa / Conference (uključujući kvalifikacije)
function isUEFA(name = "") {
  const n = String(name).toLowerCase();
  return (
    n.includes("champions league") ||
    n.includes("europa league") ||
    n.includes("conference league")
  );
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: JSON.stringify(value) })
    });
  } catch (e) {
    console.error("KV set fail:", key, e && e.message || e);
  }
}

export default async function handler(req, res) {
  try {
    const today = beogradDayKey();
    const rebuild = String(req.query.rebuild || "").trim() === "1";

    // novi dan -> reset
    if (store.dayKey && store.dayKey !== today) {
      store.dayKey = null; store.builtAt = null;
      store.pinned = null; store.backup = null; store.raw = null;
    }

    if (!rebuild && store.dayKey === today && Array.isArray(store.pinned) && store.pinned.length > 0) {
      setCDNHeaders(res);
      return res.status(200).json({ value_bets: store.pinned, built_at: store.builtAt, day: store.dayKey, source: "locked-cache" });
    }

    // pozovi interni /api/value-bets (MODEL+ODDS skup)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const innerURL = `${origin}/api/value-bets`;

    const r = await fetch(innerURL, { headers: { "x-locked-proxy": "1" } });
    if (!r.ok) {
      const text = await r.text();
      setCDNHeaders(res);
      return res.status(r.status).json({ error: "value-bets fetch failed", details: text });
    }
    const json = await r.json();
    const raw = Array.isArray(json?.value_bets) ? json.value_bets : [];

    // filtriraj buduće i rangiraj
    const future = filterFuture(raw);
    const ranked = rankBets(future);

    // ====== cap po ligi (MAX_PER_LEAGUE), sa izuzetkom UEFA takmičenja ======
    const perLeague = new Map();
    const pinned = [];
    const skippedByCap = [];

    const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();

    for (const p of ranked) {
      const lname = p?.league?.name || "";
      const key = keyOfLeague(p);

      // bez limita za UEFA (UCL/UEL/UECL, uključujući kval.)
      if (!isUEFA(lname)) {
        const cnt = perLeague.get(key) || 0;
        if (cnt >= MAX_PER_LEAGUE) {
          skippedByCap.push(p);
          continue;
        }
        perLeague.set(key, cnt + 1);
      }
      pinned.push(p);
      if (pinned.length >= LIMIT) break;
    }

    // Fallback pass: ako cap ostavi manje od LIMIT, dopuni preostalim (ignoriši cap)
    if (pinned.length < LIMIT) {
      for (const p of skippedByCap) {
        if (pinned.length >= LIMIT) break;
        pinned.push(p);
      }
      if (pinned.length < LIMIT) {
        for (const p of ranked) {
          if (pinned.length >= LIMIT) break;
          if (!pinned.includes(p)) pinned.push(p);
        }
      }
    }
    // ==============================================================================

    // backup = ostatak liste (bez pinned, zadrži redosled)
    const pinnedSet = new Set(pinned.map(p => p.fixture_id ?? `${p.league?.id}-${p.teams?.home?.name}-${p.teams?.away?.name}`));
    const backup = ranked.filter(p => {
      const id = p.fixture_id ?? `${p.league?.id}-${p.teams?.home?.name}-${p.teams?.away?.name}`;
      return !pinnedSet.has(id);
    }).slice(0, Math.max(LIMIT, 40));

    store.dayKey = today;
    store.builtAt = nowISO();
    store.pinned = pinned.slice(0, LIMIT);
    store.backup = backup;
    store.raw = future;

    // snapshot u KV (ako je uključeno) — DODATO: conf i liga info
    if (process.env.FEATURE_HISTORY === "1") {
      const snapshot = store.pinned.map(p => ({
        fixture_id: p.fixture_id,
        home: p.teams?.home?.name || "",
        away: p.teams?.away?.name || "",
        league_id: p.league?.id ?? null,
        league_name: p.league?.name || "",
        market: p.market_label || p.market || "",
        selection: p.selection || "",
        odds: p.market_odds || null,
        kickoff: p?.datetime_local?.starting_at?.date_time || null,
        conf: Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null
      }));
      await kvSet(`vb:day:${today}:last`, snapshot);
      await kvSet(`vb:day:${today}:${slotLabel()}`, snapshot);
    }

    res.setHeader("Set-Cookie", `vb_day=${today}; Path=/; SameSite=Lax; Max-Age=86400`);
    setCDNHeaders(res);
    return res.status(200).json({
      value_bets: store.pinned,
      built_at: store.builtAt,
      day: store.dayKey,
      source: rebuild ? "locked-rebuild" : "locked-build"
    });
  } catch (e) {
    setCDNHeaders(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e && e.message || e) });
  }
}
