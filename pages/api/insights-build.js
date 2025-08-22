// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

// ==== ENV ====
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const API_KEY  = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ==== KV helpers ====
async function kvGetRaw(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(() => null);
  return js && typeof js === "object" && "result" in js ? js.result : js;
}
async function kvGetJSON(key) {
  const raw = await kvGetRaw(key);
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}
async function kvSetJSON(key, val) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(val)
  });
  return r.ok;
}

// ==== time helpers ====
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // YYYY-MM-DD
}

// ==== API-FOOTBALL helpers ====
const AF_BASE = "https://v3.football.api-sports.io";

async function af(path) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${AF_BASE}${path}`, {
    headers: { "x-apisports-key": API_KEY }
  });
  if (!r.ok) throw new Error(`AF ${path} -> ${r.status}`);
  const js = await r.json();
  return js && js.response ? js.response : [];
}

async function getH2H(homeId, awayId, last = 5) {
  return af(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${last}`);
}
async function getLastMatches(teamId, last = 5) {
  return af(`/fixtures?team=${teamId}&last=${last}`);
}

// ==== logic ====
function wdlFromMatches(matches, teamId) {
  let W = 0, D = 0, L = 0, gf = 0, ga = 0;
  for (const m of matches) {
    const hId = m.teams?.home?.id;
    const aId = m.teams?.away?.id;
    const hg  = m.goals?.home ?? m.score?.fulltime?.home ?? 0;
    const ag  = m.goals?.away ?? m.score?.fulltime?.away ?? 0;
    gf += (teamId === hId) ? hg : (teamId === aId ? ag : 0);
    ga += (teamId === hId) ? ag : (teamId === aId ? hg : 0);
    let res;
    if (hg === ag) res = "D"; else if (hg > ag) res = "H"; else res = "A";
    if ((res === "H" && teamId === hId) || (res === "A" && teamId === aId)) W++;
    else if (res === "D") D++; else L++;
  }
  return { W, D, L, gf, ga };
}

function buildWhyBullets(homeForm, awayForm, h2hStats) {
  const bullets = [];
  // "Domaćin u dobroj formi" = 3+ pobede ili >=10 poena u zadnjih 5
  const homePts = homeForm.W * 3 + homeForm.D;
  if (homeForm.W >= 3 || homePts >= 10) bullets.push("Domaćin u dobroj formi");
  const awayPts = awayForm.W * 3 + awayForm.D;
  if (awayForm.ga / 5 >= 1.6) bullets.push("Gost prima puno golova");
  // H2H signal
  if (h2hStats.W >= 3) bullets.push("H2H naginje domaćinu");
  if (h2hStats.L >= 3) bullets.push("H2H naginje gostu");
  if (bullets.length === 0) bullets.push("Parametri umereni, bez jasnog trenda");
  return bullets;
}

export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();
    const unionKey = `vb:day:${ymd}:union`;
    const union = (await kvGetJSON(unionKey)) || [];
    if (!Array.isArray(union) || union.length === 0) {
      return res.status(200).json({ ok: true, updated: 0, reason: "union empty" });
    }

    // Radimo samo nad aktivnim dnevnim kandidatom (max 40 zbog rate limita)
    const candidates = union.slice(0, 40);

    const tasks = candidates.map(async (p) => {
      const fixtureId = p.fixture_id ?? p.fixture?.id ?? p.id;
      const homeId = p.teams?.home_id ?? p.teams?.home?.id ?? p.home_id;
      const awayId = p.teams?.away_id ?? p.teams?.away?.id ?? p.away_id;
      if (!fixtureId || !homeId || !awayId) return null;

      // 1) H2H poslednjih 5
      const h2hRaw = await getH2H(homeId, awayId, 5);
      const h2hStatsHome = wdlFromMatches(h2hRaw, homeId); // W/D/L iz perspektive domaćina

      // 2) Forma timova (poslednjih 5 ukupno)
      const [homeLast, awayLast] = await Promise.all([
        getLastMatches(homeId, 5),
        getLastMatches(awayId, 5)
      ]);
      const homeForm = wdlFromMatches(homeLast, homeId);
      const awayForm = wdlFromMatches(awayLast, awayId);

      // 3) Bulleti i H2H linija
      const bullets = buildWhyBullets(homeForm, awayForm, h2hStatsHome);
      const h2hLine = `W${h2hStatsHome.W} D${h2hStatsHome.D} L${h2hStatsHome.L}  •  GD: ${h2hStatsHome.gf}:${h2hStatsHome.ga}`;

      const insight = {
        fixture_id: fixtureId,
        bullets,
        h2h: { ...h2hStatsHome },
        h2hLine,
        updated_at: new Date().toISOString()
      };
      await kvSetJSON(`vb:insight:${fixtureId}`, insight);
      return true;
    });

    const results = await Promise.allSettled(tasks);
    const updated = results.filter(r => r.status === "fulfilled" && r.value).length;

    return res.status(200).json({ ok: true, updated, ymd });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
