// FILE: pages/api/insights-build.js
// Gradi kratke “Zašto” tekstove (2 linije) iz forme i H2H i upisuje u KV.
// Format (primer):
//   "Domaćin u dobroj formi; gost u lošoj formi.\nForma: Domaćin W3 D1 L1 (9:3) · Gost W1 D2 L2 (4:7)\nH2H (L5): W2 D2 L1 (6:4)"

export const config = { api: { bodyParser: false } };

const BASE = "https://v3.football.api-sports.io";

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const { result } = await r.json();
    try { return result ? JSON.parse(result) : null; } catch { return null; }
  } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  }).catch(()=>{});
}
async function afGet(path) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, "x-rapidapi-key": key }
  });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

function summarizeLast5(list, teamId) {
  let W=0,D=0,L=0,gf=0,ga=0;
  for (const fx of list.slice(0,5)) {
    const sc = fx.score?.fulltime || fx.score?.ft || fx.score || {};
    const h = Number(sc.home ?? sc.h ?? fx.goals?.home ?? 0);
    const a = Number(sc.away ?? sc.a ?? fx.goals?.away ?? 0);
    const homeId = fx.teams?.home?.id;
    const awayId = fx.teams?.away?.id;
    if (homeId == null || awayId == null) continue;
    const isHome = homeId === teamId;
    const my  = isHome ? h : a;
    const opp = isHome ? a : h;
    gf += my; ga += opp;
    if (my>opp) W++; else if (my===opp) D++; else L++;
  }
  return { W,D,L,gf,ga };
}
const fmtForm = ({W,D,L,gf,ga}) => `W${W} D${D} L${L} (${gf}:${ga})`;

function labelForm({W,L}) {
  if (W >= 3 && L <= 1) return "u dobroj formi";
  if (L >= 3 && W <= 1) return "u lošoj formi";
  return "u promenljivoj formi";
}

export default async function handler(req, res) {
  try {
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: process.env.TZ_DISPLAY||"Europe/Belgrade",
      year:"numeric", month:"2-digit", day:"2-digit"
    }).format(new Date());

    const snap = await kvGet(`vb:day:${today}:last`);
    if (!Array.isArray(snap) || snap.length === 0) {
      return res.status(200).json({ updated: 0, reason: "no snapshot" });
    }

    let updated = 0;
    for (const p of snap) {
      const fid  = p.fixture_id;
      const home = p.home_id || p.teams?.home?.id;
      const away = p.away_id || p.teams?.away?.id;
      if (!home || !away || !fid) continue;

      let homeLast = [], awayLast = [], h2h = [];
      try { homeLast = await afGet(`/fixtures?team=${home}&last=5`); } catch {}
      try { awayLast = await afGet(`/fixtures?team=${away}&last=5`); } catch {}
      try { h2h      = await afGet(`/fixtures/headtohead?h2h=${home}-${away}&last=5`); } catch {}

      const sHome = summarizeLast5(homeLast, home);
      const sAway = summarizeLast5(awayLast, away);

      let W=0,D=0,L=0,gf=0,ga=0;
      for (const fx of h2h.slice(0,5)) {
        const sc = fx.score?.fulltime || fx.score?.ft || fx.score || {};
        const h = Number(sc.home ?? fx.goals?.home ?? 0);
        const a = Number(sc.away ?? fx.goals?.away ?? 0);
        const homeId = fx.teams?.home?.id;
        const my  = (homeId === home) ? h : a;
        const opp = (homeId === home) ? a : h;
        gf += my; ga += opp;
        if (my>opp) W++; else if (my===opp) D++; else L++;
      }

      // 2-linijski tekst
      const line =
        `Domaćin ${labelForm(sHome)}; gost ${labelForm(sAway)}.\n` +
        `Forma: Domaćin ${fmtForm(sHome)} · Gost ${fmtForm(sAway)}\n` +
        `H2H (L5): W${W} D${D} L${L} (${gf}:${ga})`;

      await kvSet(`vb:insight:${fid}`, { line, built_at: new Date().toISOString() });
      updated++;
    }

    res.status(200).json({ updated, total_locked: snap.length });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
