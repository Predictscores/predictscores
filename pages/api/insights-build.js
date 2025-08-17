export const config = { api: { bodyParser: false } };

const BASE = "https://v3.football.api-sports.io";

// -- KV helpers sa bezbednim "unwrap" --
function unwrapKV(raw) {
  let v = raw;
  try {
    if (typeof v === "string") {
      const p = JSON.parse(v);
      v = (p && typeof p === "object" && "value" in p) ? p.value : p;
    }
    if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) v = JSON.parse(v);
  } catch {}
  return v;
}
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
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

// -- API-Football --
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

// -- Forma L5 (po timu) --
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
  return { W,D,L,gf,ga, gd: gf-ga };
}
const fmtForm = ({W,D,L,gf,ga}) => `W${W} D${D} L${L} (${gf}:${ga})`;

function headlineFromForms(hForm, aForm) {
  const goodHome = (hForm.W >= 3) || (hForm.gd >= 3);
  const poorAway = (aForm.L >= 3) || (aForm.gd <= -3);
  if (goodHome && poorAway) return "Domaćin u dobroj formi; gost u lošoj formi.";
  if (goodHome) return "Domaćin u dobroj formi.";
  if (poorAway) return "Gost u lošoj formi.";
  return "Forma ujednačena.";
}

function ymdTZ() {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: process.env.TZ_DISPLAY||"Europe/Belgrade", year:"numeric", month:"2-digit", day:"2-digit"
    }).format(new Date());
  } catch {
    const d=new Date(), y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), da=String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${da}`;
  }
}

export default async function handler(req, res) {
  try {
    const today = ymdTZ();
    const snap = await kvGet(`vb:day:${today}:last`);
    if (!Array.isArray(snap) || snap.length === 0) {
      return res.status(200).json({ updated: 0, reason: "no snapshot" });
    }

    let updated = 0;
    for (const p of snap) {
      const fid = p.fixture_id;
      const home = p.home_id || p.teams?.home?.id;
      const away = p.away_id || p.teams?.away?.id;
      if (!home || !away || !fid) continue;

      let homeLast = [], awayLast = [];
      try { homeLast = await afGet(`/fixtures?team=${home}&last=5`); } catch {}
      try { awayLast = await afGet(`/fixtures?team=${away}&last=5`); } catch {}

      const sHome = summarizeLast5(homeLast, home);
      const sAway = summarizeLast5(awayLast, away);

      // dve linije: headline + forma
      const headline  = headlineFromForms(sHome, sAway);
      const form_line = `Forma: Domaćin ${fmtForm(sHome)} · Gost ${fmtForm(sAway)}`;

      await kvSet(`vb:insight:${fid}`, { headline, form_line, built_at: new Date().toISOString() });
      updated++;
    }

    res.status(200).json({ updated, total_locked: snap.length });
  } catch (e) {
    res.status(500).json({ error: String(e&&e.message||e) });
  }
}
