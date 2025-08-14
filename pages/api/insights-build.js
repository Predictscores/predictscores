// FILE: pages/api/insights-build.js
// Batch gradi kratku liniju "forma/H2H" za zaključane parove i snima u KV.
// Budžet: ~3 poziva po meču (home last5, away last5, h2h last5).
export const config = { api: { bodyParser: false } };

const BASE = "https://v3.football.api-sports.io";

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

async function afGet(path) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      "x-apisports-key": key,
      "x-rapidapi-key": key // fallback; neki nalozi koriste rapidapi ključ
    }
  });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

function summarizeLast5(list, teamId) {
  let W=0,D=0,L=0, gf=0, ga=0;
  for (const fx of list.slice(0,5)) {
    const sc = fx.score?.fulltime || fx.score?.ft || fx.score || {};
    const h = Number(sc.home ?? sc.h ?? fx.goals?.home ?? 0);
    const a = Number(sc.away ?? sc.a ?? fx.goals?.away ?? 0);
    const homeId = fx.teams?.home?.id;
    const awayId = fx.teams?.away?.id;
    if (homeId == null || awayId == null) continue;
    const isHome = homeId === teamId;
    const my = isHome ? h : a;
    const opp = isHome ? a : h;
    gf += my; ga += opp;
    if (my>opp) W++; else if (my===opp) D++; else L++;
  }
  return { W,D,L,gf,ga };
}

function fmtForm({W,D,L}) { return `W${W} D${D} L${L}`; }
function fmtGoals({gf,ga}) { return `${gf}:${ga}`; }

export default async function handler(req, res) {
  try {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: process.env.TZ_DISPLAY||"Europe/Belgrade", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
    const snap = await kvGet(`vb:day:${today}:last`);
    if (!Array.isArray(snap) || snap.length === 0) {
      return res.status(200).json({ updated: 0, reason: "no snapshot" });
    }

    let updated = 0;
    for (const p of snap) {
      const fid = p.fixture_id;
      const home = p.home_id || p.teams?.home?.id;
      const away = p.away_id || p.teams?.away?.id;
      if (!home || !away) continue;

      // fetch in sequence to izbeći rate-limit
      let homeLast = [], awayLast = [], h2h = [];
      try {
        homeLast = await afGet(`/fixtures?team=${home}&last=5`);
      } catch (_) {}
      try {
        awayLast = await afGet(`/fixtures?team=${away}&last=5`);
      } catch (_) {}
      try {
        h2h = await afGet(`/fixtures/headtohead?h2h=${home}-${away}&last=5`);
      } catch (_) {}

      const sHome = summarizeLast5(homeLast, home);
      const sAway = summarizeLast5(awayLast, away);

      // H2H zbirno gledano iz perspektive "home" tima
      let W=0,D=0,L=0, gf=0, ga=0;
      for (const fx of h2h.slice(0,5)) {
        const sc = fx.score?.fulltime || fx.score?.ft || fx.score || {};
        const h = Number(sc.home ?? fx.goals?.home ?? 0);
        const a = Number(sc.away ?? fx.goals?.away ?? 0);
        const homeId = fx.teams?.home?.id;
        const awayId = fx.teams?.away?.id;
        if (homeId == null || awayId == null) continue;
        const isHome = homeId === home; // da li je naš team kao home u tom H2H meču
        const my = isHome ? h : a;
        const opp = isHome ? a : h;
        gf += my; ga += opp;
        if (my>opp) W++; else if (my===opp) D++; else L++;
      }

      const line =
        `H2H: W${W} D${D} L${L} (${gf}:${ga}) · ` +
        `Home: ${fmtForm(sHome)} · Away: ${fmtForm(sAway)}`;

      await kvSet(`vb:insight:${fid}`, { line, built_at: new Date().toISOString() });
      updated++;
    }

    return res.status(200).json({ updated, total_locked: snap.length });
  } catch (e) {
    return res.status(500).json({ error: String(e&&e.message||e) });
  }
}
