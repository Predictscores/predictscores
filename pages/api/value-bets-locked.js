// FILE: pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const store = global.__VBETS_LOCK__ || (global.__VBETS_LOCK__ = {
  dayKey: null,
  builtAt: null,
  pinned: null,   // array of 25
  backup: null,   // array of 15 (26-40)
  raw: null,      // original full payload from /api/value-bets
});

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d); // "YYYY-MM-DD"
}
function nowISO() { return new Date().toISOString(); }

function rankBets(arr = []) {
  return arr.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
    const eA = Number(a.edge ?? 0);
    const eB = Number(b.edge ?? 0);
    if (eB !== eA) return eB - eA;
    const pA = Number(a.model_prob ?? 0);
    const pB = Number(b.model_prob ?? 0);
    if (pB !== pA) return pB - pA;
    return String(a.fixture_id || "").localeCompare(String(b.fixture_id || ""));
  });
}

function setCDNHeaders(res) {
  const S_MAXAGE = Number(process.env.CDN_SMAXAGE_SEC || 600);
  const SWR      = Number(process.env.CDN_STALE_SEC     || 120);
  res.setHeader("Cache-Control", `s-maxage=${S_MAXAGE}, stale-while-revalidate=${SWR}`);
}

export default async function handler(req, res) {
  try {
    const forceRebuild = String(req.query.rebuild || "") === "1";
    const dayParam = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? String(req.query.date)
      : beogradDayKey();
    const targetDay = dayParam;

    // Clear lock if day changed OR explicit rebuild
    if (store.dayKey && (store.dayKey !== targetDay || forceRebuild)) {
      store.dayKey = null;
      store.builtAt = null;
      store.pinned = null;
      store.backup = null;
      store.raw = null;
    }

    // Serve from lock if already built for targetDay
    if (!forceRebuild && store.dayKey === targetDay && Array.isArray(store.pinned) && store.pinned.length > 0) {
      setCDNHeaders(res);
      return res.status(200).json({
        value_bets: store.pinned,
        built_at: store.builtAt,
        day: store.dayKey,
        source: "locked-cache",
      });
    }

    // Build: call our existing /api/value-bets (now returns up to VB_LIMIT=25)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const origin = `${proto}://${host}`;

    const search = new URLSearchParams(req.query);
    search.set("date", targetDay);
    // (nije potrebno, ali ne škodi) prosledi "limit" ka /api/value-bets
    const vbLimit = Number(process.env.VB_LIMIT || 25);
    search.set("limit", String(vbLimit));

    const innerURL = `${origin}/api/value-bets?${search.toString()}`;
    const innerRes = await fetch(innerURL, { headers: { "x-locked-proxy": "1" } });
    if (!innerRes.ok) {
      const text = await innerRes.text();
      setCDNHeaders(res);
      return res.status(innerRes.status).json({ error: `value-bets fetch failed`, details: text });
    }
    const json = await innerRes.json();
    const list = Array.isArray(json?.value_bets) ? json.value_bets : [];

    const ranked = rankBets(list);
    const pinned = ranked.slice(0, vbLimit);
    const backup = ranked.slice(vbLimit, vbLimit + 15);

    store.dayKey = targetDay;
    store.builtAt = nowISO();
    store.pinned = pinned;
    store.backup = backup;
    store.raw = list;

    res.setHeader("Set-Cookie", `vb_day=${targetDay}; Path=/; SameSite=Lax; Max-Age=86400`);
    setCDNHeaders(res);
    return res.status(200).json({
      value_bets: pinned,
      built_at: store.builtAt,
      day: store.dayKey,
      source: "locked-build",
    });
  } catch (e) {
    setCDNHeaders(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e && e.message || e) });
  }
}
