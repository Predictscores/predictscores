// pages/api/cron/refresh-odds.js
// Enrichuje vbl_full:<YMD>:<slot> sa kvotama (median) + ugrađenim BTTS/OU2.5 marketima.
// • 1 OA poziv po slotu (h2h,totals,btts) – čuva dnevni brojač u KV "oa:budget:<ymd>"
// • Ako je OA dnevni limit (15) već potrošen → samo vrati ok bez menjanja feeda
// • Trusted books lista je ugrađena; ako je nema u rezultatu, median je preko svih.

export const config = { api: { bodyParser: false } };

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const OA_KEY = process.env.ODDS_API_KEY;
const TZ = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();

// --- Helpers: KV
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    cache: "no-store"
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  try { return j && j.result ? JSON.parse(j.result) : null; } catch { return null; }
}
async function kvSet(key, val) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(val) })
  });
  return r.ok;
}

// --- Time helpers
function nowInTZ() {
  const now = new Date();
  return new Date(now.toLocaleString("en-GB", { timeZone: TZ }));
}
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function pickSlotFromQuery(q) {
  const s = (q.slot || "").toString().trim().toLowerCase();
  if (s === "am" || s === "pm" || s === "late") return s;
  const H = parseInt(new Date(nowInTZ()).getHours(), 10);
  if (H < 10) return "late";
  if (H < 15) return "am";
  return "pm";
}

// --- Odds helpers
const TRUSTED = new Set([
  "pinnacle", "bet365", "unibet", "bwin", "williamhill",
  "marathonbet", "skybet", "betfair", "888sport", "sbobet"
]);

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/club|fc|cf|sc|ac|afc|bc|[.\-']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function median(values) {
  const arr = values.filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Map OA response by normalized "home|away"
function indexOA(list) {
  const idx = new Map();
  for (const ev of list || []) {
    const h = normalizeName(ev.home_team);
    const a = normalizeName(ev.away_team);
    if (!h || !a) continue;
    const key = `${h}|${a}`;
    idx.set(key, ev);
  }
  return idx;
}

function pickMedianFromBooks(offers, extractor) {
  const all = [];
  const trusted = [];
  for (const b of offers || []) {
    const val = extractor(b);
    if (Number.isFinite(val)) {
      all.push(val);
      if (TRUSTED.has((b.title || b.name || "").toLowerCase())) trusted.push(val);
    }
  }
  const base = trusted.length ? trusted : all;
  return {
    price: median(base),
    books_count: base.length
  };
}

function extractMarkets(ev) {
  // ev.bookmakers[].markets[].key in { "h2h", "totals", "btts" }
  const out = { h2h: null, totals25: { over: null, under: null }, btts: { Y: null, N: null } };
  if (!ev || !Array.isArray(ev.bookmakers)) return out;

  // H2H 1X2 (we’ll keep only "home" and "away" prices; draw if present)
  const h2h = [];
  const totals = [];
  const btts = [];

  for (const bk of ev.bookmakers) {
    for (const m of bk.markets || []) {
      if (m.key === "h2h" && Array.isArray(m.outcomes)) {
        const get = (name) => (m.outcomes.find(o => (o.name || o.title) === name)?.price);
        h2h.push({ title: bk.title || bk.key || "", h: get("Home"), d: get("Draw"), a: get("Away") });
      }
      if (m.key === "totals" && Array.isArray(m.outcomes)) {
        for (const o of m.outcomes) {
          const point = Number(o.point);
          if (point === 2.5) totals.push({ title: bk.title || bk.key || "", o: o.name === "Over" ? o.price : undefined, u: o.name === "Under" ? o.price : undefined });
        }
      }
      if ((m.key === "btts" || m.key === "both_teams_to_score") && Array.isArray(m.outcomes)) {
        const getB = (name) => (m.outcomes.find(o => (o.name || o.title) === name)?.price);
        btts.push({ title: bk.title || bk.key || "", y: getB("Yes"), n: getB("No") });
      }
    }
  }

  if (h2h.length) {
    const medH = pickMedianFromBooks(h2h, b => Number(b.h));
    const medD = pickMedianFromBooks(h2h, b => Number(b.d));
    const medA = pickMedianFromBooks(h2h, b => Number(b.a));
    out.h2h = { home: medH, draw: medD, away: medA };
  }
  if (totals.length) {
    const medO = pickMedianFromBooks(totals, b => Number(b.o));
    const medU = pickMedianFromBooks(totals, b => Number(b.u));
    out.totals25 = { over: medO, under: medU };
  }
  if (btts.length) {
    const medY = pickMedianFromBooks(btts, b => Number(b.y));
    const medN = pickMedianFromBooks(btts, b => Number(b.n));
    out.btts = { Y: medY, N: medN };
  }
  return out;
}

async function callOAOnce() {
  if (!OA_KEY) return { called: false, used_before: 0, used_after: 0, events: 0, data: [] };

  const d = nowInTZ();
  const keyBudget = `oa:budget:${ymd(d)}`;
  const b = (await kvGet(keyBudget)) || { used: 0 };

  const used_before = Number(b.used || 0);
  if (used_before >= 15) {
    return { called: false, used_before, used_after: used_before, events: 0, data: [] };
  }

  // Jedan "upcoming" poziv – markets: h2h, totals, btts; regions EU
  const url = `https://api.the-odds-api.com/v4/sports/upcoming/odds?regions=eu&markets=h2h,totals,btts&oddsFormat=decimal&dateFormat=iso&apiKey=${encodeURIComponent(OA_KEY)}`;
  let data = [];
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) data = await r.json();
  } catch (_) {
    // ignore – fallback će odraditi koliko može
  }

  const used_after = used_before + 1;
  await kvSet(keyBudget, { used: used_after });

  return { called: true, used_before, used_after, events: Array.isArray(data) ? data.length : 0, data: Array.isArray(data) ? data : [] };
}

export default async function handler(req, res) {
  const slot = pickSlotFromQuery(req.query);
  const d = nowInTZ();
  const day = ymd(d);
  const keyFull = `vbl_full:${day}:${slot}`;

  const src = await kvGet(keyFull);
  if (!src || !Array.isArray(src.items)) {
    return res.status(200).json({ ok: true, ymd: day, slot, msg: "no vbl_full", saves: false, oa: { called: false, used_before: 0, used_after: 0, events: 0 } });
  }

  // Jedan OA poziv sa markets=h2h,totals,btts
  const oa = await callOAOnce();
  const idx = indexOA(oa.data);

  let touched = 0;
  for (const it of src.items) {
    try {
      const h = normalizeName(it?.teams?.home?.name || it?.home?.name);
      const a = normalizeName(it?.teams?.away?.name || it?.away?.name);
      if (!h || !a) continue;
      const ev = idx.get(`${h}|${a}`);
      if (!ev) continue;

      // Izvuci tržišta
      const m = extractMarkets(ev);

      // Upis u item – ne diramo postojeće 1X2 polje ako postoji;
      // dodamo 'markets' čvor koji će koristiti insights-build
      it.markets = it.markets || {};
      if (m.h2h) {
        it.markets.h2h = {
          home: m.h2h.home,
          draw: m.h2h.draw,
          away: m.h2h.away
        };
      }
      if (m.totals25) {
        it.markets.ou25 = {
          over: m.totals25.over,
          under: m.totals25.under
        };
      }
      if (m.btts) {
        it.markets.btts = {
          Y: m.btts.Y,
          N: m.btts.N
        };
      }

      touched++;
    } catch {
      // continue
    }
  }

  // Snimi nazad (idempotentno)
  await kvSet(keyFull, src);

  return res.status(200).json({
    ok: true,
    ymd: day,
    slot,
    inspected: src.items.length,
    touched,
    source: keyFull,
    saves: [{ flavor: "vercel-kv", ok: true }],
    oa
  });
}
