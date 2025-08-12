// FILE: pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

const store = global.__VBETS_LOCK__ || (global.__VBETS_LOCK__ = {
  dayKey: null,
  builtAt: null,   // ISO (UTC)
  builtLocalHour: null, // broj sata u Europe/Belgrade kad je urađen build
  pinned: null,    // array (Top-N)
  backup: null,    // array (sledećih 15)
  raw: null
});

function beogradDayKey(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d); // "YYYY-MM-DD"
}
function belgradeHour(d = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Belgrade",
      hour: "2-digit",
      hour12: false
    }).format(d)
  );
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
  const S_MAXAGE = Number(process.env.CDN_SMAXAGE_SEC || 600);   // 10 min
  const SWR      = Number(process.env.CDN_STALE_SEC     || 120); // 2 min
  res.setHeader("Cache-Control", `s-maxage=${S_MAXAGE}, stale-while-revalidate=${SWR}`);
}

export default async function handler(req, res) {
  try {
    const targetDay = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
      ? String(req.query.date)
      : beogradDayKey();

    const lockHour = Number(process.env.LOCK_BUILD_HOUR || 14); // ⟵ default 14:00
    const vbLimit  = Number(process.env.VB_LIMIT || 25);
    const now = new Date();
    const todayKey = beogradDayKey(now);
    const nowHr = belgradeHour(now);

    const forceRebuild = String(req.query.rebuild || "") === "1";

    // Reset ako menjamo dan u locku ili ako je tražen rebuild za drugi dan
    if (store.dayKey && (store.dayKey !== targetDay) && !forceRebuild) {
      store.dayKey = null;
      store.builtAt = null;
      store.builtLocalHour = null;
      store.pinned = null;
      store.backup = null;
      store.raw = null;
    }

    // AUTO re-lock u 14:00: ako već postoji današnji lock ali je napravljen pre 14h, a sada je posle 14h -> rebuild
    const needAutoRelock =
      store.dayKey === todayKey &&
      typeof store.builtLocalHour === "number" &&
      store.builtLocalHour < lockHour &&
      nowHr >= lockHour;

    // Serve iz memorije ako imamo lock za traženi dan i nije potreban auto-relock, niti forceRebuild
    if (!needAutoRelock && !forceRebuild && store.dayKey === targetDay && Array.isArray(store.pinned) && store.pinned.length > 0) {
      setCDNHeaders(res);
      return res.status(200).json({
        value_bets: store.pinned,
        built_at: store.builtAt,
        day: store.dayKey,
        source: "locked-cache"
      });
    }

    // Ako je target današnji dan, a još uvek je PRE 14:00 i nemamo lock — NEMOJ auto-build (izbegavamo rani set).
    // Dozvoljen je build samo ako je forceRebuild=1 ili je posle 14h.
    if (targetDay === todayKey && nowHr < lockHour && !forceRebuild) {
      // Ako već postoji neki lock (npr. iz ranijeg cold starta), posluži ga; inače prazan set uz "pending"
      setCDNHeaders(res);
      return res.status(200).json({
        value_bets: Array.isArray(store.pinned) ? store.pinned : [],
        built_at: store.builtAt,
        day: targetDay,
        pending_until_hour: lockHour,
        source: "locked-pending"
      });
    }

    // --- Build (ili Re-build) ---
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const origin = `${proto}://${host}`;

    const search = new URLSearchParams(req.query);
    search.set("date", targetDay);
    search.set("limit", String(vbLimit));

    // Vrlo važno: pošalji header da rewrite NE presretne ovaj poziv
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
    store.builtLocalHour = belgradeHour(new Date()); // zabeleži lokalan sat kad je rađen build
    store.pinned = pinned;
    store.backup = backup;
    store.raw = list;

    res.setHeader("Set-Cookie", `vb_day=${targetDay}; Path=/; SameSite=Lax; Max-Age=86400`);
    setCDNHeaders(res);
    return res.status(200).json({
      value_bets: pinned,
      built_at: store.builtAt,
      day: store.dayKey,
      source: needAutoRelock ? "locked-auto14" : (forceRebuild ? "locked-rebuild" : "locked-build")
    });
  } catch (e) {
    setCDNHeaders(res);
    return res.status(500).json({ error: "locked endpoint error", message: String(e && e.message || e) });
  }
}
