// FILE: pages/api/history.js
export const config = { api: { bodyParser: false } };

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}

function decideStatus(p, sc) {
  if (!sc || sc.ftH == null || sc.ftA == null) return null;
  const ftH = Number(sc.ftH), ftA = Number(sc.ftA);
  const market = (p.market || "").toLowerCase();
  const sel = String(p.selection || "").toUpperCase();

  // BTTS
  if (market.includes("btts")) {
    const yes = sel.includes("YES");
    const hit = (ftH > 0 && ftA > 0);
    return yes ? (hit ? "won" : "lost") : (hit ? "lost" : "won");
  }
  // Over/Under 2.5 (ili drugi OU)
  if (market.includes("over") || market.includes("under") || market.includes("ou")) {
    const m = String(p.market).match(/([0-9]+(?:\.[0-9]+)?)/);
    const line = m ? Number(m[1]) : 2.5;
    const total = ftH + ftA;
    const over = sel.includes("OVER");
    if (total === line) return null; // push/void — ne računamo
    return over ? (total > line ? "won" : "lost") : (total < line ? "won" : "lost");
  }
  // 1X2 / Match Winner
  if (market.includes("1x2") || market === "1x2" || market.includes("match winner")) {
    const ft = ftH > ftA ? "1" : (ftH < ftA ? "2" : "X");
    const want = sel.includes("HOME") ? "1" : sel.includes("AWAY") ? "2" : sel.includes("DRAW") ? "X" : sel;
    return ft === want ? "won" : "lost";
  }
  // HT/FT
  if (market.includes("ht-ft") || market.includes("ht/ft")) {
    const htH = sc.htH, htA = sc.htA;
    if (htH == null || htA == null) return null;
    const ht = htH > htA ? "1" : (htH < htA ? "2" : "X");
    const ft = ftH > ftA ? "1" : (ftH < ftA ? "2" : "X");
    const norm = String(p.selection||"").replace(/\s+/g,"").toUpperCase();
    const m = norm.match(/([12X])[/\-]?([12X])/);
    if (!m) return null;
    return (m[1] === ht && m[2] === ft) ? "won" : "lost";
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const day = String(req.query.day || "").trim();
    if (!day) return res.status(400).json({ ok:false, error: "Missing ?day=YYYY-MM-DD" });

    const snap = await kvGet(`vb:day:${day}:last`);
    if (!Array.isArray(snap)) return res.status(200).json({ ok:true, day, items: [] });

    const items = [];
    for (const p of snap) {
      const fid = p?.fixture_id;
      const sc = fid ? await kvGet(`vb:score:${fid}`) : null;
      const status = decideStatus(p, sc);
      const home = p?.teams?.home || p?.home_team_name || "";
      const away = p?.teams?.away || p?.away_team_name || "";
      const market = p?.market || "";
      const pick = p?.selection || "";
      const final = sc && sc.ftH != null && sc.ftA != null ? `${sc.ftH}:${sc.ftA}` : "-";
      const hit = status === "won";
      const emoji = status == null ? "•" : (hit ? "✅" : "❌");
      items.push({
        fixture_id: fid,
        match: `${home} — ${away}`,
        market,
        pick,
        final,
        hit,
        emoji,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok:true, day, total: items.length, items });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
