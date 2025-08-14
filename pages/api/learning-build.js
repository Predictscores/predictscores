// FILE: pages/api/learning-build.js
export const config = { api: { bodyParser: false } };

// --- KV helpers
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
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}

// --- helpers
function laplaceRate(wins, total, alpha=1, beta=1) { return (wins + alpha) / (total + alpha + beta); }
function toPP(x) { return Math.round(x * 1000) / 10; } // 1 decimal pp

export default async function handler(req, res) {
  try {
    const days = Math.max(7, Math.min(60, Number(process.env.LEARN_WINDOW_DAYS || req.query.days || 30)));
    const now = new Date();

    const rows = []; // resolved picks with status + shown conf
    for (let i = 0; i < days; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0,10);
      const snap = await kvGet(`vb:day:${ymd}:last`);
      if (!Array.isArray(snap)) continue;

      for (const p of snap) {
        const sc = await kvGet(`vb:score:${p.fixture_id}`);
        if (!sc || sc.ftH==null || sc.ftA==null) continue;
        const ftH = Number(sc.ftH), ftA = Number(sc.ftA);
        const market = (p.market || "").toLowerCase();

        let status = null;
        // BTTS
        if (market.includes("btts")) {
          const yes = String(p.selection||"").toLowerCase().includes("yes");
          const hit = (ftH>0 && ftA>0);
          status = yes ? (hit?"won":"lost") : (hit?"lost":"won");
        }
        // OU (try extract line)
        else if (market.includes("over") || market.includes("under") || market.includes("ou")) {
          const m = String(p.market).match(/([0-9]+(?:\.[0-9]+)?)/);
          const line = m ? Number(m[1]) : 2.5;
          const total = ftH + ftA;
          const over = String(p.selection||"").toLowerCase().includes("over");
          if (total !== line) status = over ? (total>line?"won":"lost") : (total<line?"won":"lost");
        }
        // 1X2
        else if (market.includes("1x2") || market === "1x2" || market.includes("match winner")) {
          const sel = String(p.selection||"").toUpperCase();
          const ft = ftH>ftA?"1":(ftH<ftA?"2":"X");
          if (["1","2","X","HOME","AWAY","DRAW"].some(s=>sel.includes(s))) {
            const want = sel.includes("HOME")?"1":sel.includes("AWAY")?"2":sel.includes("DRAW")?"X":sel;
            status = ft===want?"won":"lost";
          }
        }
        // HT-FT (best-effort)
        else if (market.includes("ht-ft") || market.includes("ht/ft")) {
          const htH = sc.htH, htA = sc.htA;
          if (htH!=null && htA!=null) {
            const ht = htH>htA?"1":(htH<htA?"2":"X");
            const ft = ftH>ftA?"1":(ftH<ftA?"2":"X");
            const norm = String(p.selection||"").replace(/\s+/g,"").toUpperCase();
            const m = norm.match(/([12X])[/\-]?([12X])/);
            if (m) status = (m[1]===ht && m[2]===ft)?"won":"lost";
          }
        }

        if (!status) continue;
        const conf = Number.isFinite(p.conf) ? Number(p.conf) : null;

        rows.push({
          market: p.market || "",
          league: p.league_name || "",
          status,
          conf
        });
      }
    }

    // aggregate
    const aggMarket = new Map();         // market -> {n,w,confSum,confN}
    const aggLeague = new Map();         // (market||league) -> {n,w}
    for (const r of rows) {
      const kM = r.market.toLowerCase();
      const kL = `${kM}||${(r.league||"").toLowerCase()}`;

      let m = aggMarket.get(kM);
      if (!m) { m = { market:r.market, n:0, w:0, confSum:0, confN:0 }; aggMarket.set(kM, m); }
      m.n += 1; if (r.status==="won") m.w += 1;
      if (Number.isFinite(r.conf)) { m.confSum += r.conf; m.confN += 1; }

      let l = aggLeague.get(kL);
      if (!l) { l = { market:r.market, league:r.league, n:0, w:0 }; aggLeague.set(kL, l); }
      l.n += 1; if (r.status==="won") l.w += 1;
    }

    const calibMarket = {};
    for (const [k, a] of aggMarket.entries()) {
      const act = laplaceRate(a.w, a.n);
      const pred = a.confN ? (a.confSum / a.confN) / 100 : null;
      const delta = (pred!=null) ? (act - pred) : 0;
      calibMarket[k] = { samples: a.n, win_rate_pp: toPP(act), avg_conf_pp: pred!=null?toPP(pred):null, delta_pp: toPP(delta) };
    }

    const calibLeague = {};
    for (const [k, a] of aggLeague.entries()) {
      if (a.n < 25) continue; // need some sample
      const [mk, lgKey] = k.split("||");
      const m = aggMarket.get(mk);
      if (!m) continue;
      const actL = laplaceRate(a.w, a.n);
      const actM = laplaceRate(m.w, m.n);
      const diff = actL - actM;
      if (!calibLeague[mk]) calibLeague[mk] = {};
      calibLeague[mk][lgKey] = { samples: a.n, delta_vs_market_pp: toPP(diff) };
    }

    const out = {
      built_at: new Date().toISOString(),
      window_days: days,
      market: calibMarket,
      league: calibLeague
    };

    await kvSet("vb:learn:calib:latest", out);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: String(e&&e.message||e) });
  }
}
