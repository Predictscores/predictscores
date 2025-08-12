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

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
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

    // pozovi interni /api/value-bets (koji sada vraća SAMO MODEL+ODDS)
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

    const future = filterFuture(raw);
    const ranked = rankBets(future);
    const pinned = ranked.slice(0, LIMIT);
    const backup = ranked.slice(LIMIT, Math.max(LIMIT, 40));

    store.dayKey = today;
    store.builtAt = nowISO();
    store.pinned = pinned;
    store.backup = backup;
    store.raw = future;

    res.setHeader("Set-Cookie", `vb_day=${today}; Path=/; SameSite=Lax; Max-Age=86400`);
    setCDNHeaders(res);
    return res.status(200).json({
      value_bets: pinned,
      built_at: store.builtAt,
      day: store.dayKey,
      source: rebuild ? "locked-rebuild" : "locked-build"
    });
  } catch (e) {
    setCDNHeaders(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e && e.message || e) });
  }
}
