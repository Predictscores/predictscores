// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

// ENV
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const API_KEY  = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

// ---------- KV ----------
async function kvGetJSON(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(() => null);
  if (!js) return null;
  const val = "result" in js ? js.result : js;
  try { return typeof val === "string" ? JSON.parse(val) : val; } catch { return null; }
}
async function kvSetJSON(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body
  });
  return r.ok;
}

// ---------- time ----------
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // YYYY-MM-DD
}

// ---------- API-FOOTBALL ----------
const AF_BASE = "https://v3.football.api-sports.io";

async function af(path) {
  if (!API_KEY) return [];
  const r = await fetch(`${AF_BASE}${path}`, { headers: { "x-apisports-key": API_KEY } });
  if (!r.ok) return [];
  const js = await r.json().catch(() => ({}));
  return js?.response ?? [];
}

async function getH2H(homeId, awayId, last = 5) {
  return af(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=${last}`);
}
async function getLastMatches(teamId, last = 5) {
  return af(`/fixtures?team=${teamId}&last=${last}`);
}

function wdlFromMatches(matches, teamId) {
  let W = 0, D = 0, L = 0, gf = 0, ga = 0;
  for (const m of matches || []) {
    const hId = m?.teams?.home?.id;
    const aId = m?.teams?.away?.id;
    const hg = m?.goals?.home ?? m?.score?.fulltime?.home ?? 0;
    const ag = m?.goals?.away ?? m?.score?.fulltime?.away ?? 0;
    if (teamId === hId) { gf += hg; ga += ag; }
    else if (teamId === aId) { gf += ag; ga += hg; }
    const res = hg === ag ? "D" : (hg > ag ? "H" : "A");
    if ((res === "H" && teamId === hId) || (res === "A" && teamId === aId)) W++;
    else if (res === "D") D++; else L++;
  }
  return { W, D, L, gf, ga };
}

function bulletsFrom(homeForm, awayForm, h2hHome) {
  const bullets = [];
  const homePts = homeForm.W * 3 + homeForm.D;
  if (homeForm.W >= 3 || homePts >= 10) bullets.push("Domaćin u dobroj formi");
  if ((awayForm.ga ?? 0) / 5 >= 1.6) bullets.push("Gost prima puno golova");
  if (h2hHome.W >= 3) bullets.push("H2H naginje domaćinu");
  if (h2hHome.L >= 3) bullets.push("H2H naginje gostu");
  if (!bullets.length) bullets.push("Parametri umereni, bez jasnog trenda");
  return bullets;
}

export default async function handler(req, res) {
  try {
    const ymd = ymdInTZ();
    const union = (await kvGetJSON(`vb:day:${ymd}:union`)) || [];
    if (!Array.isArray(union) || union.length === 0) {
      return res.status(200).json({ ok: true, updated: 0, reason: "union empty" });
    }

    // Zbog rate limita – maksimalno 25 po pozivu
    const candidates = union.slice(0, 25);

    const tasks = candidates.map(async (p) => {
      const fixtureId = p?.fixture_id ?? p?.fixture?.id ?? p?.id;
      const homeId = p?.teams?.home_id ?? p?.teams?.home?.id ?? p?.home_id;
      const awayId = p?.teams?.away_id ?? p?.teams?.away?.id ?? p?.away_id;
      if (!fixtureId || !homeId || !awayId) return false;

      const [h2hRaw, homeLast, awayLast] = await Promise.all([
        getH2H(homeId, awayId, 5),
        getLastMatches(homeId, 5),
        getLastMatches(awayId, 5),
      ]);

      const h2hHome = wdlFromMatches(h2hRaw, homeId);
      const homeForm = wdlFromMatches(homeLast, homeId);
      const awayForm = wdlFromMatches(awayLast, awayId);

      const bullets = bulletsFrom(homeForm, awayForm, h2hHome);
      const h2hLine = `W${h2hHome.W} D${h2hHome.D} L${h2hHome.L}  •  GD: ${h2hHome.gf}:${h2hHome.ga}`;

      const insight = {
        fixture_id: fixtureId,
        bullets,
        h2h: { ...h2hHome },
        h2hLine,
        updated_at: new Date().toISOString(),
      };
      await kvSetJSON(`vb:insight:${fixtureId}`, JSON.stringify(insight));
      return true;
    });

    const results = await Promise.allSettled(tasks);
    const updated = results.filter(r => r.status === "fulfilled" && r.value).length;

    return res.status(200).json({ ok: true, updated, ymd });
  } catch (e) {
    return res.status(200).json({ ok: false, updated: 0, error: String(e?.message || e) });
  }
}
