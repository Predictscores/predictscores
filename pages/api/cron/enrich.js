// FILE: pages/api/cron/enrich.js
// Enrich za PINOVANE mečeve: sabira formu (L5 home/away) i pravi 2 human linije.
// Upisuje u KV: vb:enrich:<fixture_id> = { human: [line1, line2], ts }
// TTL ~ 6h. Bez novih ENV. Siguran fallback: ako nešto fali, ništa se ne kvari.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

const ENRICH_TTL_SEC = 6 * 3600;   // 6h
const L5_WINDOW = 5;               // poslednjih 5 mečeva za formu
const MAX_ENRICH = 40;             // safety limit

// ============ helpers (KV) ============
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
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return unwrapKV(j && typeof j.result !== "undefined" ? j.result : null);
  } catch { return null; }
}
async function kvSet(key, value, opts = {}) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    const body = { value: typeof value === "string" ? value : JSON.stringify(value) };
    if (opts.ex) body.ex = opts.ex;
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}
function ymdTZ(d = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(d);
  } catch {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}

// ============ helpers (AF) ============
function maskErr(e){ try { return String(e?.message || e); } catch { return "unknown"; } }

async function afGet(path) {
  const key =
    process.env.NEXT_PUBLIC_API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY ||
    process.env.API_FOOTBALL_KEY_1 ||
    process.env.API_FOOTBALL_KEY_2;

  if (!key) throw new Error("API_FOOTBALL_KEY missing");
  const r = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": key }
  });
  if (!r.ok) throw new Error(`AF ${path} -> ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

function getMatchScore(row) {
  // vrati {homeGoals, awayGoals} i da li je završeno
  const ft = row?.score?.fulltime || {};
  let home = Number.isFinite(row?.goals?.home) ? row.goals.home : Number(ft?.home);
  let away = Number.isFinite(row?.goals?.away) ? row.goals.away : Number(ft?.away);
  if (!Number.isFinite(home)) home = null;
  if (!Number.isFinite(away)) away = null;
  const status = String(row?.fixture?.status?.short || row?.fixture?.status?.long || "");
  const finished = /FT|AET|PEN|Match Finished|Finished/i.test(status) || (home !== null && away !== null);
  return { home, away, finished };
}

function lastNByVenue(rows, teamId, venueWanted /* "home" | "away" */, n=L5_WINDOW) ) {
  // izvuci poslednje završene mečeve za tim sa željenim venue, najskorije prvo
  const arr = [];
  for (const r of rows || []) {
    const fh = r?.teams?.home?.id;
    const fa = r?.teams?.away?.id;
    if (!fh || !fa) continue;
    const isHome = fh === teamId;
    const isAway = fa === teamId;
    if (venueWanted === "home" && !isHome) continue;
    if (venueWanted === "away" && !isAway) continue;
    const { home, away, finished } = getMatchScore(r);
    if (!finished) continue;
    const dtMs = new Date(r?.fixture?.date || r?.fixture?.timestamp*1000 || Date.now()).getTime();
    arr.push({ isHome, isAway, home, away, dtMs });
  }
  arr.sort((a,b)=> b.dtMs - a.dtMs);
  return arr.slice(0, n);
}

function summarizeForm(rows, teamId, asHome) {
  // rows su već filtrirani na venue i završene, najskorije prvo
  let W=0,D=0,L=0, gf=0, ga=0;
  for (const r of rows) {
    const my = asHome ? r.home : r.away;
    const opp= asHome ? r.away : r.home;
    if (!Number.isFinite(my) || !Number.isFinite(opp)) continue;
    gf += my; ga += opp;
    if (my > opp) W++; else if (my === opp) D++; else L++;
  }
  return { W, D, L, gf, ga, gd: gf-ga };
}

function formHeadline(homeForm, awayForm) {
  const goodHome = (homeForm.W >= 3) || (homeForm.gd >= 3);
  const poorAway = (awayForm.L >= 3) || (awayForm.gd <= -3);
  if (goodHome && poorAway) return "Domaćin u dobroj formi; gost u lošoj formi.";
  if (goodHome) return "Domaćin u dobroj formi.";
  if (poorAway) return "Gost u lošoj formi.";
  return "Forma ujednačena.";
}

function fmtFormLine(h, a) {
  const hLine = `Domaćin W${h.W} D${h.D} L${h.L} (${h.gf}:${h.ga})`;
  const aLine = `Gost W${a.W} D${a.D} L${a.L} (${a.gf}:${a.ga})`;
  return `Forma: ${hLine} · ${aLine}`;
}

export default async function handler(req, res) {
  try {
    const day = ymdTZ();
    const snap = unwrapKV(await kvGet(`vb:day:${day}:last`));
    const list = Array.isArray(snap) ? snap : [];
    if (!list.length) {
      return res.status(200).json({ ok: true, enriched: 0, note: "no snapshot" });
    }

    let enriched = 0;
    const uniqFixtures = [];
    const seen = new Set();
    for (const p of list) {
      const fid = Number(p?.fixture_id);
      if (!fid || seen.has(fid)) continue;
      seen.add(fid);
      uniqFixtures.push({ fid, p });
      if (uniqFixtures.length >= MAX_ENRICH) break;
    }

    for (const { fid, p } of uniqFixtures) {
      const key = `vb:enrich:${fid}`;
      const existing = unwrapKV(await kvGet(key));
      if (existing && existing.ts) {
        const age = Date.now() - new Date(existing.ts).getTime();
        if (age < ENRICH_TTL_SEC * 1000) continue; // sveže, preskoči
      }

      const homeId = Number(p?.teams?.home?.id);
      const awayId = Number(p?.teams?.away?.id);
      if (!homeId || !awayId) continue;

      // 1) skupi poslednje 10 mečeva po timu (da filtriramo venue sami)
      const hRows = await afGet(`/fixtures?team=${homeId}&last=10`);
      const aRows = await afGet(`/fixtures?team=${awayId}&last=10`);

      const hLast = lastNByVenue(hRows, homeId, "home", L5_WINDOW);
      const aLast = lastNByVenue(aRows, awayId, "away", L5_WINDOW);

      if (hLast.length < 1 || aLast.length < 1) continue;

      const hForm = summarizeForm(hLast, homeId, true);
      const aForm = summarizeForm(aLast, awayId, false);

      const line1 = formHeadline(hForm, aForm);               // npr: "Domaćin u dobroj formi."
      const line2 = fmtFormLine(hForm, aForm);                 // npr: "Forma: Domaćin W3 D1 L1 (9:3) · Gost W1 D2 L2 (4:7)"

      const payload = { human: [line1, line2], ts: new Date().toISOString() };
      await kvSet(key, payload, { ex: ENRICH_TTL_SEC });
      enriched++;
    }

    return res.status(200).json({ ok: true, enriched });
  } catch (e) {
    return res.status(200).json({ ok: false, error: maskErr(e) });
  }
}
