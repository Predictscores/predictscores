// pages/api/cron/rebuild.js
// Gradi listu fudbalskih kandidata iz API-Football predikcija i kvota.
// - slot filtering (late/am/pm) po Europe/Belgrade
// - /predictions?fixture=<id> i /odds?fixture=<id>
// - konsenzus kvote (median) za 1X2; model_prob iz predikcija
// - EV i bazni confidence
// - dry=1 -> samo vrati; bez dry -> upiši u KV: vbl:YYYY-MM-DD:slot i vbl_full:YYYY-MM-DD:slot

export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;

// Vercel KV
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

// --- helpers: KV ---
async function kvGet(key) {
  if (!KV_URL || (!KV_TOKEN && !KV_TOKEN_RO)) return null;
  const token = KV_TOKEN_RO || KV_TOKEN;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || typeof j.result === "undefined") return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const body = new URLSearchParams();
  body.set("value", typeof value === "string" ? value : JSON.stringify(value));
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` }, body,
  }).catch(() => null);
  return !!(r && r.ok);
}

// --- helpers: time/slot ---
function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function hourMinInTZ(isoUtc, tz = TZ) {
  const d = new Date(isoUtc);
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(d);
  const hh = Number(p.find(x => x.type === "hour").value);
  const mm = Number(p.find(x => x.type === "minute").value);
  return { hh, mm, str: `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}` };
}
function inSlot(hh, mm, slot) {
  const m = hh * 60 + mm;
  if (slot === "late") return m >= 0 && m < 600;        // 00:00–09:59
  if (slot === "am")   return m >= 600 && m < 900;      // 10:00–14:59
  return m >= 900 && m < 1440;                          // 15:00–23:59
}
function autoSlot() {
  const d = new Date();
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false })
    .formatToParts(d);
  const hh = Number(p.find(x => x.type === "hour").value);
  if (hh < 10) return "late";
  if (hh < 15) return "am";
  return "pm";
}

// --- helpers: AF ---
async function af(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${AF_BASE}${path}?${qs}`;
  const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY }, cache: "no-store" });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(`AF error: ${JSON.stringify(j.errors)}`);
  return j;
}
function median(arr) {
  if (!arr || !arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}
function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// --- EV helpers ---
function probToFairOdds(p) { p = clamp(p, 1e-6, 0.999999); return 1/p; }
function evPercent(modelProb, price) {
  if (!modelProb || !price) return null;
  return (probToFairOdds(modelProb) - price) / price; // e.g. 0.05 = +5%
}

// --- build one fixture (predictions + odds) ---
async function buildForFixture(fx) {
  const fixtureId = fx.fixture.id;
  // 1) Predictions
  const pred = await af("/predictions", { fixture: fixtureId }).catch(() => null);
  if (!pred || !Array.isArray(pred.response) || pred.response.length === 0) return null;
  const p = pred.response[0];

  // Extract model probs for 1/X/2 from percent fields if available
  // API-Football returns strings like "home": "45%", "draw":"25%", "away":"30%"
  const perc = p?.predictions?.percent || p?.predictions || {};
  const ph = toNum(String(perc.home || "").replace("%","")) || null;
  const pd = toNum(String(perc.draw || "").replace("%","")) || null;
  const pa = toNum(String(perc.away || "").replace("%","")) || null;

  if (ph === null && pd === null && pa === null) return null;

  // choose top outcome
  const cand = [
    { key: "1", prob: ph ? ph/100 : 0 },
    { key: "X", prob: pd ? pd/100 : 0 },
    { key: "2", prob: pa ? pa/100 : 0 },
  ].sort((a,b)=>b.prob-a.prob)[0];
  if (!cand || cand.prob <= 0) return null;

  // 2) Odds for the fixture (1X2 consensus per selection)
  const o = await af("/odds", { fixture: fixtureId }).catch(() => null);
  if (!o || !Array.isArray(o.response) || o.response.length === 0) return null;

  const prices = { "1": [], "X": [], "2": [] };
  let booksCount = 0;
  for (const row of o.response) {
    const bkm = row?.bookmakers || [];
    for (const b of bkm) {
      const vals = (b?.bets || []).find(bb => (bb.name || "").toLowerCase().includes("match winner") || bb.id === 1)?.values || [];
      if (vals.length) booksCount++;
      for (const v of vals) {
        const label = (v.value || v.label || "").trim().toUpperCase(); // "Home", "Draw", "Away" or "1/X/2"
        const map = /home/i.test(label) ? "1" : /draw/i.test(label) ? "X" : /away/i.test(label) ? "2" :
                    (["1","X","2"].includes(label) ? label : null);
        const pr = toNum(v.odd);
        if (map && pr && pr > 1.01) prices[map].push(pr);
      }
    }
  }
  const price = median(prices[cand.key]);
  if (!price) return null;

  const league = {
    id: fx.league?.id,
    name: fx.league?.name,
    country: fx.league?.country
  };
  const teams = {
    home: fx.teams?.home?.name,
    away: fx.teams?.away?.name
  };
  const koUtc = fx.fixture?.date || null;
  const { hh, mm, str } = hourMinInTZ(koUtc, TZ);

  const modelProb = cand.prob; // 0..1
  const ev = evPercent(modelProb, price);

  // Bazni confidence: 55–85, grubo iz (modelProb vs implied)
  const implied = 1 / price;
  let conf = 55 + (modelProb - implied) * 100 * 1.2; // malo “oštrije”
  conf = clamp(Math.round(conf), 50, 88);

  return {
    fixture_id: fixtureId,
    market: "1X2",
    pick: cand.key,                // "1" | "X" | "2"
    model_prob: Number(modelProb.toFixed(4)),
    confidence_pct: conf,
    odds: { price: Number(price.toFixed(3)), books_count: booksCount },
    league,
    teams,
    kickoff: `${ymdInTZ(new Date(koUtc))} ${str}`,
    kickoff_utc: koUtc,
    source_meta: { books_counts_raw: { "1": prices["1"].length, "X": prices["X"].length, "2": prices["2"].length } }
  };
}

// --- main handler ---
export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const dry = String(req.query.dry || "") === "1";
    const ymd = ymdInTZ();

    // 0) današnje fiksture
    const fx = await af("/fixtures", { date: ymd });
    const fixtures = (fx.response || []).filter(r => {
      const t = hourMinInTZ(r.fixture?.date || "");
      return inSlot(t.hh, t.mm, slot);
    });

    // 1) limit da ne potrošimo previše (realno dosta je 300 po slotu)
    const MAX_FIXTURES = 300;
    const todo = fixtures.slice(0, MAX_FIXTURES);

    // 2) paralelizacija sa ograničenjem (da ne “rokuje” API)
    const CONC = 8;
    const out = [];
    for (let i = 0; i < todo.length; i += CONC) {
      const batch = todo.slice(i, i + CONC);
      const results = await Promise.all(batch.map(buildForFixture).map(p => p.catch(() => null)));
      results.forEach(r => { if (r) out.push(r); });
    }

    // 3) rangiraj po EV
    out.sort((a,b) => (b._ev || evPercent(b.model_prob, b.odds?.price) || -1) - (a._ev || evPercent(a.model_prob, a.odds?.price) || -1));

    const full = out.slice(0, 50); // vbl_full (za Football tab)
    const slim = out.slice(0, 15); // vbl (kraća lista)

    const keys = {
      vbl: `vbl:${ymd}:${slot}`,
      vbl_full: `vbl_full:${ymd}:${slot}`
    };

    if (!dry) {
      await kvSet(keys.vbl_full, full);
      await kvSet(keys.vbl, slim);
    }

    return res.status(200).json({
      ok: true,
      slot, ymd,
      count: slim.length,
      count_full: full.length,
      football: dry ? full : slim,        // u dry modu vrati “puniju” sliku da se lakše debuguje
      tier_buckets: { tier1: 0, tier2: 0, tier3: 0 }, // (ostavljeno za kasnije)
      source: `rebuild(api-football predictions+odds)·dry:${dry ? "1":"0"}`,
      keys
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
