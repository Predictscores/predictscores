// pages/api/cron/rebuild.js
// Jedina ruta koja zove API-Football. Puni KV (vbl, vbl_full) i History.
// Pick je string ("Home/Draw/Away"). Po difoltu isključuje ženske lige (heuristike).

export const config = { runtime: "nodejs" };

const TZ = "Europe/Belgrade";
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN_RO = process.env.KV_REST_API_READ_ONLY_TOKEN;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || KV_TOKEN_RO;

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
  if (slot === "late") return m >= 0 && m < 600;   // 00:00–09:59
  if (slot === "am")   return m >= 600 && m < 900; // 10:00–14:59
  return m >= 900 && m < 1440;                     // 15:00–23:59
}
function autoSlot() {
  const d = new Date();
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).formatToParts(d);
  const hh = Number(p.find(x => x.type === "hour").value);
  if (hh < 10) return "late";
  if (hh < 15) return "am";
  return "pm";
}

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
function isWomenLeague(league) {
  const name = (league?.name || "").toLowerCase();
  const country = (league?.country || "").toLowerCase();
  return /(women|femenin|feminine|femminile|feminino|frauen|女子|dames)/i.test(name)
      || /(women|女子|femenin)/i.test(country);
}
function isWomenByTeams(home, away) {
  const rg = /\b(w|women|ladies|fem|femin[a|e|o]?|frauen|dames)\b/i;
  return rg.test(home || "") || rg.test(away || "");
}
function probToFairOdds(p) { p = clamp(p, 1e-6, 0.999999); return 1/p; }
function evPercent(modelProb, price) { if (!modelProb || !price) return null; return (probToFairOdds(modelProb) - price) / price; }
function labelForPick(k){ return k==="1"?"Home":k==="2"?"Away":"Draw"; }

async function buildForFixture(fx) {
  const fixtureId = fx.fixture.id;

  const pred = await af("/predictions", { fixture: fixtureId }).catch(() => null);
  if (!pred || !Array.isArray(pred.response) || pred.response.length === 0) return null;
  const p = pred.response[0];
  const perc = p?.predictions?.percent || p?.predictions || {};
  const ph = toNum(String(perc.home || "").replace("%","")) || null;
  const pd = toNum(String(perc.draw || "").replace("%","")) || null;
  const pa = toNum(String(perc.away || "").replace("%","")) || null;
  if (ph === null && pd === null && pa === null) return null;

  const top = [
    { key: "1", prob: ph ? ph/100 : 0 },
    { key: "X", prob: pd ? pd/100 : 0 },
    { key: "2", prob: pa ? pa/100 : 0 },
  ].sort((a,b)=>b.prob-a.prob)[0];
  if (!top || top.prob <= 0) return null;

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
        const label = (v.value || v.label || "").trim().toUpperCase();
        const map = /home/i.test(label) ? "1" : /draw/i.test(label) ? "X" : /away/i.test(label) ? "2" :
                    (["1","X","2"].includes(label) ? label : null);
        const pr = toNum(v.odd);
        if (map && pr && pr > 1.01) prices[map].push(pr);
      }
    }
  }
  const price = median(prices[top.key]);
  if (!price) return null;

  const league = { id: fx.league?.id, name: fx.league?.name, country: fx.league?.country };
  const teams = { home: fx.teams?.home?.name, away: fx.teams?.away?.name };
  const koUtc = fx.fixture?.date || null;
  const { str } = hourMinInTZ(koUtc, TZ);

  const modelProb = top.prob;
  const implied = 1 / price;
  const ev = evPercent(modelProb, price);

  let conf = 55 + (modelProb - implied) * 100 * 1.2;
  conf = clamp(Math.round(conf), 50, 88);

  return {
    fixture_id: fixtureId,
    market: "1X2",
    pick: labelForPick(top.key),
    pick_code: top.key,
    selection_label: labelForPick(top.key),

    model_prob: Number(modelProb.toFixed(4)),
    confidence_pct: conf,
    odds: { price: Number(price.toFixed(3)), books_count: booksCount },

    league,
    league_name: league.name,
    league_country: league.country,

    teams,
    home: teams.home,
    away: teams.away,

    kickoff: `${ymdInTZ(new Date(koUtc))} ${str}`,
    kickoff_utc: koUtc,

    _implied: Number(implied.toFixed(4)),
    _ev: ev,
    source_meta: { books_counts_raw: { "1": prices["1"].length, "X": prices["X"].length, "2": prices["2"].length } }
  };
}

export default async function handler(req, res) {
  try {
    const qslot = String(req.query.slot || "").toLowerCase();
    const slot = ["am","pm","late"].includes(qslot) ? qslot : autoSlot();
    const dry = String(req.query.dry || "") === "1";
    const includeWomen = String(req.query.includeWomen || "0") === "1";
    const ymd = ymdInTZ();

    const fx = await af("/fixtures", { date: ymd });
    let fixtures = (fx.response || []).filter(r => {
      const { hh, mm } = hourMinInTZ(r.fixture?.date || "");
      return inSlot(hh, mm, slot);
    });

    if (!includeWomen) {
      fixtures = fixtures.filter(r => {
        const byLeague = !isWomenLeague(r.league);
        const home = r?.teams?.home?.name || "";
        const away = r?.teams?.away?.name || "";
        const byTeams = !isWomenByTeams(home, away);
        return byLeague && byTeams;
      });
    }

    const MAX_FIXTURES = 150; // limit da budeš daleko ispod 5k/dan
    const todo = fixtures.slice(0, MAX_FIXTURES);

    const CONC = 8;
    const out = [];
    for (let i = 0; i < todo.length; i += CONC) {
      const batch = todo.slice(i, i + CONC);
      const results = await Promise.all(batch.map(buildForFixture).map(p => p.catch(() => null)));
      results.forEach(r => { if (r) out.push(r); });
    }

    out.forEach(x => { if (typeof x._ev !== "number" && x.model_prob && x.odds?.price) x._ev = (1/x.model_prob - x.odds.price)/x.odds.price; });
    out.sort((a,b) => (b._ev ?? -1) - (a._ev ?? -1));

    const full = out.slice(0, 50);
    const slim = out.slice(0, 15);

    const keys = { vbl: `vbl:${ymd}:${slot}`, vbl_full: `vbl_full:${ymd}:${slot}` };

    if (!dry) {
      await kvSet(keys.vbl_full, full);
      await kvSet(keys.vbl, slim);

      // History
      await kvSet(`hist:${ymd}:${slot}`, full);
      let idx = await kvGet("hist:index");
      if (!Array.isArray(idx)) idx = [];
      const tag = `${ymd}:${slot}`;
      if (!idx.includes(tag)) {
        const next = [tag, ...idx].slice(0, 120);
        await kvSet("hist:index", next);
      }
    }

    return res.status(200).json({
      ok: true,
      slot, ymd,
      count: slim.length,
      count_full: full.length,
      football: dry ? full : slim,
      source: `rebuild(api-football predictions+odds)·women:${includeWomen?"on":"off"}·dry:${dry?"1":"0"}`,
      keys
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
