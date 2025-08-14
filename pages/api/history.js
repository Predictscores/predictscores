// FILE: pages/api/history.js
export const config = { api: { bodyParser: false } };

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

  // Over/Under x.y (uzima broj iz market stringa)
  if (market.includes("over") || market.includes("under") || market.includes("ou")) {
    const m = p.market.match(/([0-9]+(?:\.[0-9]+)?)/);
    const line = m ? Number(m[1]) : 2.5;
    if (selection.includes("over")) {
      if (total === line) return null; // push ne prikazujemo
      return total > line ? "won" : "lost";
    }
    if (selection.includes("under")) {
      if (total === line) return null;
      return total < line ? "won" : "lost";
    }
  }

  // 1X2
  if (market.includes("1x2") || market.includes("match winner") || market === "1x2") {
    if (selection === "1" || selection.includes("home")) return ftH > ftA ? "won" : (ftH === ftA ? null : "lost");
    if (selection === "2" || selection.includes("away")) return ftA > ftH ? "won" : (ftH === ftA ? null : "lost");
    if (selection === "x" || selection.includes("draw")) return ftH === ftA ? "won" : "lost";
  }

  // HT-FT (trazimo npr "X/1", "HT X / FT 1", "Draw/Home")
  if (market.includes("ht-ft") || market.includes("ht/ft")) {
    const ht = (sc.htH!=null && sc.htA!=null) ? (sc.htH>sc.htA?"1":(sc.htH<sc.htA?"2":"X")) : null;
    const ft = ftH>ftA?"1":(ftH<ftA?"2":"X");
    const norm = selection
      .replace(/\s+/g,"").replace("ht","").replace("ft","").replace(/draw/gi,"X").replace(/home/gi,"1").replace(/away/gi,"2");
    const m = norm.match(/([12X])[/\-]([12X])/i) || norm.match(/^([12x])([12x])$/i);
    if (!ht || !m) return null;
    const wantHT = m[1].toUpperCase(), wantFT = m[2].toUpperCase();
    return (ht===wantHT && ft===wantFT) ? "won" : "lost";
  }

  return null;
}

export default async function handler(req, res) {
  if (process.env.FEATURE_HISTORY !== "1") {
    return res.status(200).json({ history: [] });
  }
  try {
    const days = 30;
    const now = new Date();
    const rows = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const ymd = d.toISOString().slice(0,10);
      const snapshot = await kvGet(`vb:day:${ymd}:last`);
      if (!Array.isArray(snapshot)) continue;

      for (const p of snapshot) {
        const sc = await kvGet(`vb:score:${p.fixture_id}`);
        const status = evalPick(p, sc);
        if (!status) continue; // prikazujemo samo zavrsene
        rows.push({
          fixture_id: p.fixture_id,
          home: p.home, away: p.away,
          market: p.market, selection: p.selection,
          odds: p.odds, ft: sc?.ft || null,
          status
        });
      }
    }

    // najskoriji na vrh; po želji možeš limitirati npr. na 200
    res.status(200).json({ history: rows });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
