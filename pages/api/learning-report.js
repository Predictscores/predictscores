// FILE: pages/api/learning-report.js
export const config = { api: { bodyParser: false } };

// ---- KV helpers
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

// ---- Eval market outcome from FT/HT score
function evalPick(p, sc) {
  if (!p || !sc || !sc.ft) return null;
  const { ft, ht } = sc;
  if (p.market === "1X2") {
    const diff = (ft.home ?? 0) - (ft.away ?? 0);
    if (p.pick_code === "1") return diff > 0 ? 1 : 0;
    if (p.pick_code === "X") return diff === 0 ? 1 : 0;
    if (p.pick_code === "2") return diff < 0 ? 1 : 0;
  }
  if (p.market === "OU2.5") {
    const goals = (ft.home ?? 0) + (ft.away ?? 0);
    if (p.pick_code === "O") return goals > 2 ? 1 : 0;
    if (p.pick_code === "U") return goals < 3 ? 1 : 0;
  }
  if (p.market === "BTTS") {
    const yes = (ft.home ?? 0) > 0 && (ft.away ?? 0) > 0;
    if (p.pick_code === "Y") return yes ? 1 : 0;
    if (p.pick_code === "N") return !yes ? 1 : 0;
  }
  if (p.market === "HT-FT" && sc.ht) {
    const dft = (ft.home ?? 0) - (ft.away ?? 0);
    const dht = (sc.ht.home ?? 0) - (sc.ht.away ?? 0);
    const code = (x) => (x > 0 ? "H" : x < 0 ? "A" : "D");
    return `${code(dht)}-${code(dft)}` === p.pick_code ? 1 : 0;
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days || "30")));
    const now = new Date();
    const tz = process.env.TZ_DISPLAY || "Europe/Belgrade";
    const base = new Date(now.toLocaleString("en-GB", { timeZone: tz }));

    const ymds = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
      ymds.push(`${y}-${m}-${dd}`);
    }

    const rows = [];

    for (const ymd of ymds) {
      // ★ Promena: čitamo dnevni snapshot sa :union
      const snap = await kvGet(`vb:day:${ymd}:union`);
      if (!snap || !snap.items) continue;

      for (const it of snap.items) {
        const pick = it && it.market ? { market: it.market, pick_code: it.pick_code } : null;
        const scoreRaw = await kvGet(`vb:score:${it.fixture_id}`);
        if (!scoreRaw) continue;
        const sc = typeof scoreRaw === "string" ? JSON.parse(scoreRaw) : scoreRaw;
        const won = evalPick(pick, sc);
        if (won == null) continue;

        rows.push({
          ymd,
          league: it.league?.id ?? "unknown",
          market: pick.market,
          pick_code: pick.pick_code,
          price: it?.odds?.price ?? null,
          implied: it?.odds?.price ? 1 / Number(it.odds.price) : null,
          won
        });
      }
    }

    const marketReport = {};
    const leagueAdjust = [];

    for (const r of rows) {
      if (!marketReport[r.market]) marketReport[r.market] = { total: 0, won: 0, implied: [] };
      marketReport[r.market].total++;
      marketReport[r.market].won += r.won;
      if (r.implied != null) marketReport[r.market].implied.push(r.implied);
    }

    for (const [m, v] of Object.entries(marketReport)) {
      const wr = v.total ? v.won / v.total : 0;
      const imp = v.implied.length ? v.implied.reduce((a,b)=>a+b,0) / v.implied.length : null;
      marketReport[m] = {
        samples: v.total,
        win_rate_pct: Math.round(wr * 1000) / 10,
        mean_implied_pct: imp != null ? Math.round(imp * 1000) / 10 : null,
        delta_vs_market_pp: imp != null ? Math.round((wr - imp) * 1000) / 10 : null
      };
    }

    // liga-level (ograničeno na 200 izlaza radi bezbednosti)
    const byLeague = {};
    for (const r of rows) {
      if (!byLeague[r.league]) byLeague[r.league] = { total: 0, won: 0, implied: [] };
      byLeague[r.league].total++;
      byLeague[r.league].won += r.won;
      if (r.implied != null) byLeague[r.league].implied.push(r.implied);
    }
    for (const [lg, v] of Object.entries(byLeague)) {
      const wr = v.total ? v.won / v.total : 0;
      const imp = v.implied.length ? v.implied.reduce((a,b)=>a+b,0)/v.implied.length : null;
      leagueAdjust.push({
        league: lg,
        samples: v.total,
        win_rate_pct: Math.round(wr * 1000) / 10,
        mean_implied_pct: imp != null ? Math.round(imp * 1000) / 10 : null,
        delta_vs_market_pp: imp != null ? Math.round((wr - imp) * 1000) / 10 : null
      });
    }
    leagueAdjust.sort((x,y)=> Math.abs(y.delta_vs_market_pp) - Math.abs(x.delta_vs_market_pp));

    return res.status(200).json({
      window_days: days,
      samples_total: rows.length,
      markets: marketReport,
      league_adjustments: leagueAdjust.slice(0, 200) // safety cap
    });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
