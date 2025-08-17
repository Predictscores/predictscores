// Nightly learning/calibration builder.
// Čita poslednjih N dana zaključanih snapshotova + rezultate iz KV (vb:score:<fixture_id>),
// računa delta između prikazanog confidence-a i realne win-rate po marketu i po ligi,
// i upisuje rezime u vb:learn:calib:latest (bez menjanja rangiranja u feedu).
//
// Pokretanje:
//   GET /api/learning-build            (default days=30)
//   GET /api/learning-build?days=60
//
// Scheduler: jednom dnevno oko 22:30 CET je dovoljno (sa NX lockom u tvom /api/cron/scheduler)
//
// Napomena: radi samo sa FEATURE_HISTORY=1 (da postoje vb:day:YYYY-MM-DD:last ključevi)

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result !== "undefined" ? j.result : null;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KV_TOKEN}`,
    },
    body: JSON.stringify({
      value: typeof value === "string" ? value : JSON.stringify(value),
    }),
  });
  const j = await r.json().catch(() => null);
  return j?.result === "OK";
}

function fmtDate(d, tz = TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(d)
    .replace(/\//g, "-");
}

function addDays(d, diff) {
  const dd = new Date(d);
  dd.setUTCDate(dd.getUTCDate() + diff);
  return dd;
}

function parseScore(obj) {
  // Očekujemo npr: { ft: { home, away }, ht: {...} } ili sličan oblik.
  try {
    const s = typeof obj === "string" ? JSON.parse(obj) : obj;
    const ft = s?.ft || s?.fulltime || s?.full_time || s?.score || null;
    if (!ft) return null;
    const home = Number(ft.home ?? ft.h ?? ft[0]);
    const away = Number(ft.away ?? ft.a ?? ft[1]);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
    return { home, away };
  } catch (_) {
    return null;
  }
}

function resolveOutcome(market, selection, score /* {home,away} */) {
  const m = String(market || "").toUpperCase();
  const sel = String(selection || "").toUpperCase();
  const { home, away } = score;

  if (m === "1X2" || m === "1X2 FT" || m === "FT 1X2") {
    const winner = home > away ? "HOME" : home < away ? "AWAY" : "DRAW";
    const map = { "1": "HOME", "2": "AWAY", X: "DRAW", HOME: "HOME", AWAY: "AWAY", DRAW: "DRAW" };
    return map[sel] === winner;
  }

  if (m.includes("BTTS")) {
    const yes = home > 0 && away > 0;
    const map = { YES: true, NO: false };
    return map[sel] === yes;
  }

  if (m.includes("OVER")) {
    // Ekstrakcija praga iz selekcije: "Over 2.5", "OVER_2_5", "OVER2.5"
    const th =
      /([0-9]+(?:\.[0-9])?)/.exec(selection)?.[1] ||
      /([0-9]+(?:_[0-9])?)/.exec(selection)?.[1]?.replace("_", ".") ||
      "2.5";
    const limit = Number(th);
    if (!Number.isFinite(limit)) return null;
    return home + away > limit;
  }

  // HT-FT i ostalo: za sada preskačemo (vrati null da ne ulazi u statistiku)
  return null;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const days = Math.max(1, Math.min(90, parseInt(req.query.days || "30", 10)));
    const today = new Date();

    const samples = []; // { market, league, conf (0..100), win (bool) }

    for (let i = 0; i < days; i++) {
      const d = fmtDate(addDays(today, -i), TZ);
      const raw = await kvGet(`vb:day:${d}:last`);
      const snap = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
      if (!Array.isArray(snap) || !snap.length) continue;

      for (const p of snap) {
        const market = p?.market || "";
        const conf = Number(p?.confidence ?? p?.confidence_pct ?? p?.conf ?? NaN);
        const league = p?.league?.name || p?.league_name || "";
        const fid = p?.fixture_id || p?.fixture || p?.id;
        if (!fid || !market || !Number.isFinite(conf)) continue;

        const scRaw = await kvGet(`vb:score:${fid}`);
        const sc = parseScore(scRaw);
        if (!sc) continue;

        const ok = resolveOutcome(market, p?.selection || p?.selectionLabel, sc);
        if (ok === null) continue; // nepodržano tržište -> preskoči

        samples.push({
          market: String(market).toUpperCase(),
          league,
          conf: Math.max(0, Math.min(100, conf)),
          win: !!ok,
        });
      }
    }

    // Agregacija
    const aggMarket = {}; // { [m]: { wins, total, confSum } }
    const aggLeague = {}; // { [m]: { [league]: { wins, total } } }

    for (const s of samples) {
      aggMarket[s.market] ||= { wins: 0, total: 0, confSum: 0 };
      aggMarket[s.market].wins += s.win ? 1 : 0;
      aggMarket[s.market].total += 1;
      aggMarket[s.market].confSum += s.conf;

      aggLeague[s.market] ||= {};
      aggLeague[s.market][s.league] ||= { wins: 0, total: 0 };
      aggLeague[s.market][s.league].wins += s.win ? 1 : 0;
      aggLeague[s.market][s.league].total += 1;
    }

    // Laplace smoothing i delte
    const out = { market: {}, league: {} };

    // Market-level delta: (WR - avgConf) u procentnim poenima
    for (const [m, v] of Object.entries(aggMarket)) {
      const wr = (v.wins + 1) / (v.total + 2); // Laplace (1,1)
      const avgConf = (v.confSum / Math.max(1, v.total)) / 100; // 0..1
      out.market[m] = {
        delta_pp: Math.round((wr - avgConf) * 1000) / 10, // npr. +2.7pp
        wr_pct: Math.round(wr * 1000) / 10, // za debug/izveštaj (opciono)
        avg_conf_pct: Math.round((avgConf * 100) * 10) / 10,
        total: v.total,
      };
    }

    // League vs market delta: (WR_league - WR_market) u pp
    for (const [m, leagues] of Object.entries(aggLeague)) {
      // izračunaj WR_market sa istim smoothingom
      const base = aggMarket[m]
        ? (aggMarket[m].wins + 1) / (aggMarket[m].total + 2)
        : null;

      out.league[m] ||= {};
      for (const [lg, v] of Object.entries(leagues)) {
        const wr = (v.wins + 1) / (v.total + 2);
        const deltaVsMkt =
          base === null ? 0 : Math.round((wr - base) * 1000) / 10; // pp
        out.league[m][lg] = {
          delta_vs_market_pp: deltaVsMkt,
          wr_pct: Math.round(wr * 1000) / 10,
          total: v.total,
        };
      }
    }

    await kvSet("vb:learn:calib:latest", out);

    return res
      .status(200)
      .json({ ok: true, days, samples: samples.length, wrote: "vb:learn:calib:latest" });
  } catch (err) {
    console.error("learning-build error", err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
