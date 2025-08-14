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
  if (!sc || sc.ftH == null || sc.ftA == null) return null;
  const ftH = Number(sc.ftH), ftA = Number(sc.ftA);
  const total = ftH + ftA;
  const market = String(p.market || "").toLowerCase();
  const selection = String(p.selection || "").toLowerCase();

  // BTTS
  if (market.includes("btts")) {
    const yes = selection.includes("yes");
    const hit = yes ? (ftH>0 && ftA>0) : !(ftH>0 && ftA>0);
    return hit ? "won" : "lost";
  }
  // OU (extract line like 2.5)
  if (market.includes("over") || market.includes("under") || market.includes("ou")) {
    const m = String(p.market).match(/([0-9]+(?:\.[0-9]+)?)/);
    const line = m ? Number(m[1]) : 2.5;
    if (selection.includes("over")) {
      if (total === line) return null;
      return total > line ? "won" : "lost";
    }
    if (selection.includes("under")) {
      if (total === line) return null;
      return total < line ? "won" : "lost";
    }
  }
  // 1X2
  if (market.includes("1x2") || market === "1x2" || market.includes("match winner")) {
    if (selection === "1" || selection.includes("home")) return ftH > ftA ? "won" : (ftH === ftA ? null : "lost");
    if (selection === "2" || selection.includes("away")) return ftA > ftH ? "won" : (ftH === ftA ? null : "lost");
    if (selection === "x" || selection.includes("draw")) return ftH === ftA ? "won" : "lost";
  }
  // HT-FT
  if (market.includes("ht-ft") || market.includes("ht/ft")) {
    const ht = (sc.htH!=null && sc.htA!=null) ? (sc.htH>sc.htA?"1":(sc.htH<sc.htA?"2":"X")) : null;
    const ft = ftH>ftA?"1":(ftH<ftA?"2":"X");
    const norm = selection.replace(/\s+/g,"").replace("ht","").replace("ft","").replace(/draw/gi,"X").replace(/home/gi,"1").replace(/away/gi,"2");
    const m = norm.match(/([12X])[/\-]([12X])/i) || norm.match(/^([12x])([12x])$/i);
    if (!ht || !m) return null;
    const wantHT = m[1].toUpperCase(), wantFT = m[2].toUpperCase();
    return (ht===wantHT && ft===wantFT) ? "won" : "lost";
  }
  return null;
}

// ---- Smoothing helpers
function laplaceRate(wins, total, alpha=1, beta=1) {
  return (wins + alpha) / (total + alpha + beta);
}
function toPP(x) { return Math.round(x * 1000) / 10; } // one decimal pp

export default async function handler(req, res) {
  try {
    const days = Math.max(7, Math.min(60, Number(req.query.days || 30)));
    const now = new Date();

    const rows = []; // flattened resolved picks with status + conf
    for (let i = 0; i < days; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0,10);
      const snap = await kvGet(`vb:day:${ymd}:last`);
      if (!Array.isArray(snap)) continue;

      for (const p of snap) {
        const sc = await kvGet(`vb:score:${p.fixture_id}`);
        const status = evalPick(p, sc);
        if (!status) continue;
        rows.push({
          market: p.market || "",
          league: p.league_name || "",
          conf: Number.isFinite(p.conf) ? Number(p.conf) : null,
          status
        });
      }
    }

    // Aggregate per market (global) and per (market, league)
    const aggMarket = new Map();
    const aggLeague = new Map(); // key: market||league

    for (const r of rows) {
      const kM = r.market.toLowerCase();
      const kL = `${kM}||${(r.league||"").toLowerCase()}`;

      // market
      let aM = aggMarket.get(kM);
      if (!aM) { aM = { market: r.market, n:0, w:0, confSum:0, confN:0 }; aggMarket.set(kM, aM); }
      aM.n += 1; if (r.status === "won") aM.w += 1;
      if (Number.isFinite(r.conf)) { aM.confSum += r.conf; aM.confN += 1; }

      // league
      let aL = aggLeague.get(kL);
      if (!aL) { aL = { market: r.market, league: r.league, n:0, w:0 }; aggLeague.set(kL, aL); }
      aL.n += 1; if (r.status === "won") aL.w += 1;
    }

    // Build report
    const marketReport = [];
    for (const [, a] of aggMarket) {
      const actual = laplaceRate(a.w, a.n);
      const pred = a.confN ? (a.confSum / a.confN) / 100 : null;
      const delta = (pred!=null) ? (actual - pred) : null;
      marketReport.push({
        market: a.market,
        samples: a.n,
        win_rate: toPP(actual),           // %
        avg_conf_shown: pred!=null ? toPP(pred) : null, // %
        calibration_delta_pp: delta!=null ? toPP(delta) : null // +pp = podcenili smo, -pp = precenili smo
      });
    }
    marketReport.sort((x,y)=> y.samples - x.samples);

    const leagueAdjust = [];
    for (const [, a] of aggLeague) {
      const mKey = a.market.toLowerCase();
      const m = aggMarket.get(mKey);
      if (!m || a.n < 25) continue; // treba malo uzorka
      const actL = laplaceRate(a.w, a.n);
      const actM = laplaceRate(m.w, m.n);
      const diff = actL - actM;
      const abs = Math.abs(diff);
      if (abs >= 0.05) { // bar 5pp razlike
        leagueAdjust.push({
          market: a.market,
          league: a.league,
          samples: a.n,
          delta_vs_market_pp: toPP(diff), // +pp bonus, -pp malus kandidat
          suggestion: diff > 0 ? "bonus" : "malus"
        });
      }
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
