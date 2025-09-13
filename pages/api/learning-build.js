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
// Napomena: radi samo sa FEATURE_HISTORY=1 (da postoje vb:day:YYYY-MM-DD:union ključevi)

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.result === "string" ? JSON.parse(j.result) : null;
}

async function kvSet(key, val) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(val) }),
  });
  return r.ok;
}

function ymdsBack(days) {
  const out = [];
  const now = new Date();
  const belgradeNow = new Date(now.toLocaleString("en-GB", { timeZone: TZ }));
  for (let i = 0; i < days; i++) {
    const d = new Date(belgradeNow);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${dd}`);
  }
  return out;
}

function parseScore(obj) {
  // Očekujemo npr: { ft: { home, away }, ht: {...} } ili sličan oblik.
  try {
    const s = typeof obj === "string" ? JSON.parse(obj) : obj;
    const ft = s && s.ft ? s.ft : s?.fulltime || s?.ft || null;
    const ht = s && s.ht ? s.ht : s?.halftime || s?.ht || null;
    return { ft, ht };
  } catch {
    return { ft: null, ht: null };
  }
}

function evalPick(p, sc) {
  if (!p || !sc || !sc.ft) return null;
  const { ft, ht } = sc;
  // 1X2
  if (p.market === "1X2") {
    const diff = (ft.home ?? 0) - (ft.away ?? 0);
    if (p.pick_code === "1") return diff > 0 ? 1 : 0;
    if (p.pick_code === "X") return diff === 0 ? 1 : 0;
    if (p.pick_code === "2") return diff < 0 ? 1 : 0;
  }
  // OU2.5
  if (p.market === "OU2.5") {
    const goals = (ft.home ?? 0) + (ft.away ?? 0);
    if (p.pick_code === "O") return goals > 2 ? 1 : 0;
    if (p.pick_code === "U") return goals < 3 ? 1 : 0;
  }
  // BTTS
  if (p.market === "BTTS") {
    const yes = (ft.home ?? 0) > 0 && (ft.away ?? 0) > 0;
    if (p.pick_code === "Y") return yes ? 1 : 0;
    if (p.pick_code === "N") return !yes ? 1 : 0;
  }
  // HT-FT
  if (p.market === "HT-FT" && ht) {
    const dft = (ft.home ?? 0) - (ft.away ?? 0);
    const dht = (ht.home ?? 0) - (ht.away ?? 0);
    const code = (x) => (x > 0 ? "H" : x < 0 ? "A" : "D");
    return `${code(dht)}-${code(dft)}` === p.pick_code ? 1 : 0;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days || "30")));
    const list = ymdsBack(days);

    const samples = [];

    for (const ymd of list) {
      // ★ Promena: čitamo dnevni snapshot sa :union
      const day = await kvGet(`vb:day:${ymd}:union`);
      if (!day || !day.items) continue;

      for (const it of day.items) {
        const pick = it && it.market ? { market: it.market, pick_code: it.pick_code } : null;
        const sc = await kvGet(`vb:score:${it.fixture_id}`);
        const won = evalPick(pick, parseScore(sc));
        if (won == null) continue;

        const leagueKey = it.league && it.league.id ? `${it.league.id}` : "unknown";
        const marketKey = pick.market || "1X2";
        samples.push({
          league: leagueKey,
          market: marketKey,
          won,
          implied: it.odds && it.odds.price ? 1 / Number(it.odds.price) : null,
        });
      }
    }

    // agregacija (po marketu i po ligi)
    const byMarket = {};
    const byLeague = {};
    for (const s of samples) {
      if (!byMarket[s.market]) byMarket[s.market] = { total: 0, won: 0, implied: [] };
      if (!byLeague[s.league]) byLeague[s.league] = { total: 0, won: 0, implied: [] };
      byMarket[s.market].total++; byLeague[s.league].total++;
      byMarket[s.market].won += s.won; byLeague[s.league].won += s.won;
      if (s.implied != null) { byMarket[s.market].implied.push(s.implied); byLeague[s.league].implied.push(s.implied); }
    }

    function summarize(obj) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        const wr = v.total ? v.won / v.total : 0;
        const imp = v.implied.length ? v.implied.reduce((a,b)=>a+b,0)/v.implied.length : null;
        out[k] = {
          win_rate_pct: Math.round(wr * 1000) / 10,
          market_mean_implied_pct: imp != null ? Math.round(imp * 1000) / 10 : null,
          delta_vs_market_pp: imp != null ? Math.round((wr - imp) * 1000) / 10 : null,
          total: v.total,
        };
      }
      return out;
    }

    const out = {
      markets: summarize(byMarket),
      leagues: summarize(byLeague),
      window_days: days,
      samples: samples.length,
      generated_at: new Date().toISOString(),
    };

    await kvSet("vb:learn:calib:latest", out);

    return res
      .status(200)
      .json({ ok: true, days, samples: samples.length, wrote: "vb:learn:calib:latest" });
  } catch (err) {
    console.error("learning-build error", err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
