// pages/api/insights-build.js
export const config = { api: { bodyParser: false } };

const BASE = "https://v3.football.api-sports.io";

/* ---------------- KV helpers ---------------- */
function unwrapKV(raw) {
  // Odmotaj Upstash forme: result -> (string) -> JSON -> {value: "..."} -> JSON
  let v = raw;
  try {
    // ako stigne { result: ... }, izdvoji ga pre parsiranja
    if (v && typeof v === "object" && "result" in v && v.result !== undefined) {
      v = v.result;
    }
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { /* može biti plain string */ }
    }
    if (v && typeof v === "object" && "value" in v) {
      let inner = v.value;
      if (typeof inner === "string") {
        try { inner = JSON.parse(inner); } catch { /* ok */ }
      }
      v = inner;
    }
  } catch {}
  return v;
}

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return unwrapKV(j);
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.ok;
}

/* ---------------- API-Football ---------------- */
async function afGet(path) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`${BASE}${path}`, {
    headers: { "x-apisports-key": key, "x-rapidapi-key": key },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

/* ---------------- summarizers ---------------- */
function summarizeLast5(list, teamId) {
  let W = 0, D = 0, L = 0, gf = 0, ga = 0;
  for (const fx of list.slice(0, 5)) {
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
    if (my > opp) W++; else if (my === opp) D++; else L++;
  }
  return { W, D, L, gf, ga };
}
const fmtForm = ({ W, D, L }) => `W${W} D${D} L${L}`;
function formLabel(s) {
  const pts = s.W * 3 + s.D;
  if (pts >= 10) return "u odličnoj formi";
  if (pts >= 7)  return "u dobroj formi";
  if (pts <= 4)  return "u lošoj formi";
  return "u promenljivoj formi";
}

/* ---------------- handler ---------------- */
export default async function handler(req, res) {
  try {
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: process.env.TZ_DISPLAY || "Europe/Belgrade",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    // čitaj snapshot iz KV (može biti u više formata -> unwrapKV)
    const snapRaw = await kvGet(`vb:day:${today}:last`);
    const snap = unwrapKV(snapRaw);

    if (!Array.isArray(snap) || snap.length === 0) {
      return res.status(200).json({ updated: 0, reason: "no snapshot" });
    }

    let updated = 0;
    for (const p of snap) {
      const fid  = p.fixture_id;
      const home = p.home_id || p.teams?.home?.id;
      const away = p.away_id || p.teams?.away?.id;
      if (!fid || !home || !away) continue;

      let homeLast = [], awayLast = [], h2h = [];
      try { homeLast = await afGet(`/fixtures?team=${home}&last=5`); } catch (_) {}
      try { awayLast = await afGet(`/fixtures?team=${away}&last=5`); } catch (_) {}
      try { h2h      = await afGet(`/fixtures/headtohead?h2h=${home}-${away}&last=5`); } catch (_) {}

      const sHome = summarizeLast5(homeLast, home);
      const sAway = summarizeLast5(awayLast, away);

      // H2H agregat
      let W = 0, D = 0, L = 0, gf = 0, ga = 0;
      for (const fx of h2h.slice(0, 5)) {
        const sc = fx.score?.fulltime || fx.score?.ft || fx.score || {};
        const h = Number(sc.home ?? fx.goals?.home ?? 0);
        const a = Number(sc.away ?? fx.goals?.away ?? 0);
        const homeId = fx.teams?.home?.id;
        const isHome = homeId === home;
        const my  = isHome ? h : a;
        const opp = isHome ? a : h;
        gf += my; ga += opp;
        if (my > opp) W++; else if (my === opp) D++; else L++;
      }

      // Tekstualni “Zašto” (u tvom formatu)
      const lead     = `Domaćin ${formLabel(sHome)}; gost ${formLabel(sAway)}.`;
      const formLine = `Forma: Domaćin ${fmtForm(sHome)} (${sHome.gf}:${sHome.ga}) · Gost ${fmtForm(sAway)} (${sAway.gf}:${sAway.ga})`;
      const h2hLine  = (W + D + L) > 0 ? `H2H (L5): W${W} D${D} L${L} (${gf}:${ga})` : null;
      const line     = h2hLine ? `${lead}\n${formLine}\n${h2hLine}` : `${lead}\n${formLine}`;

      await kvSet(`vb:insight:${fid}`, { line, built_at: new Date().toISOString() });
      updated++;
    }

    res.status(200).json({ updated, total_locked: snap.length });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
}
