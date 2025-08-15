// FILE: pages/api/cron/rebuild.js
// Jedini izvor istine za dnevni snapshot (10:00 & 15:00) + ugradjen LEARNING (jučerašnji dan)
export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 15));
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2)); // UEFA izuzeci se primenjuju ispod

function beogradYMD(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
}
function isUEFA(name = "") {
  const n = String(name).toLowerCase();
  return n.includes("champions league") || n.includes("europa league") || n.includes("conference league");
}

// --- KV helpers
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
async function kvIncr(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 0;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify(["INCR", key])
  }).catch(()=>null);
  if (!r) return 0;
  const j = await r.json().catch(()=>({}));
  return Number(j?.result||0);
}

// --- helperi
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }
function filterFuture(arr=[]) {
  const now = Date.now();
  return arr.filter(x => {
    const iso = x?.datetime_local?.starting_at?.date_time;
    const t = parseISO(iso);
    return Number.isFinite(t) && t > now;
  });
}
function rankBase(arr = []) {
  return arr.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
    const s = (b._score||0) - (a._score||0);
    if (s) return s;
    const eA = Number.isFinite(a.edge_pp)?a.edge_pp:-999;
    const eB = Number.isFinite(b.edge_pp)?b.edge_pp:-999;
    if (eB !== eA) return eB - eA;
    return String(a.fixture_id||"").localeCompare(String(b.fixture_id||""));
  });
}

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
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  return Array.isArray(j?.response) ? j.response : [];
}

export default async function handler(req, res) {
  try {
    const headers = { "x-internal": "1" };

    // 1) GENERATE: pozovi generator (cron/internal)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const gen = await fetch(`${origin}/api/value-bets`, { headers });
    if (!gen.ok) {
      const t = await gen.text();
      return res.status(502).json({ error: "generator_failed", details: t });
    }
    const payload = await gen.json();
    const raw = Array.isArray(payload?.value_bets) ? payload.value_bets : [];

    // 2) FUTURE + RANK + cap po ligi + LIMIT
    const future = filterFuture(raw);
    const ranked = rankBase(future);

    const perLeague = new Map();
    const pinned = [];
    const skipped = [];
    const keyOfLeague = (p) => String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();
    for (const p of ranked) {
      const lname = p?.league?.name || "";
      const key = keyOfLeague(p);
      if (!isUEFA(lname)) {
        const cnt = perLeague.get(key) || 0;
        if (cnt >= MAX_PER_LEAGUE) { skipped.push(p); continue; }
        perLeague.set(key, cnt + 1);
      }
      pinned.push(p);
      if (pinned.length >= LIMIT) break;
    }

    const today = beogradYMD();
    await kvSet(`vb:day:${today}:last`, pinned);
    const newRev = await kvIncr(`vb:day:${today}:rev`);

    // 3) LEARNING: jučerašnji rezultati (1 AF call)
    const d = new Date();
    d.setDate(d.getDate()-1);
    const ymd = beogradYMD(d);

    const ySnap = await kvGet(`vb:day:${ymd}:last`);
    if (Array.isArray(ySnap) && ySnap.length) {
      const fx = await afGet(`/fixtures?date=${ymd}`); // jedan poziv
      const byId = new Map();
      for (const f of fx) {
        const id = Number(f?.fixture?.id);
        const ftH = f?.score?.fulltime?.home ?? f?.goals?.home;
        const ftA = f?.score?.fulltime?.away ?? f?.goals?.away;
        const htH = f?.score?.halftime?.home ?? null;
        const htA = f?.score?.halftime?.away ?? null;
        if (Number.isFinite(id)) byId.set(id, { ftH, ftA, htH, htA });
      }

      // agregacija
      function laplaceRate(wins, total, alpha=1, beta=1) { return (wins + alpha) / (total + alpha + beta); }
      function toPP(x) { return Math.round(x * 1000) / 10; }

      const rows = [];
      for (const p of ySnap) {
        const sc = byId.get(Number(p.fixture_id));
        if (!sc || sc.ftH==null || sc.ftA==null) continue;
        const ftH = Number(sc.ftH), ftA = Number(sc.ftA);
        const market = (p.market || p.market_label || "").toLowerCase();
        const sel = String(p.selection||"");

        let status = null;
        if (market.includes("btts")) {
          const yes = sel.toLowerCase().includes("yes");
          const hit = (ftH>0 && ftA>0);
          status = yes ? (hit?"won":"lost") : (hit?"lost":"won");
        } else if (market.includes("over") || market.includes("under") || market.includes("ou")) {
          const m = (p.market || p.market_label || "").match(/([0-9]+(?:\.[0-9]+)?)/);
          const line = m ? Number(m[1]) : 2.5;
          const total = ftH + ftA;
          const over = sel.toLowerCase().includes("over");
          if (total !== line) status = over ? (total>line?"won":"lost") : (total<line?"won":"lost");
        } else if (market.includes("1x2") || market === "1x2" || market.includes("match winner")) {
          const ft = ftH>ftA?"1":(ftH<ftA?"2":"X");
          const want = sel.includes("HOME")?"1":sel.includes("AWAY")?"2":sel.includes("DRAW")?"X":sel.toUpperCase();
          status = ft===want?"won":"lost";
        } else if (market.includes("ht-ft") || market.includes("ht/ft")) {
          const htH = sc.htH, htA = sc.htA;
          if (htH!=null && htA!=null) {
            const ht = htH>htA?"1":(htH<htA?"2":"X");
            const ft = ftH>ftA?"1":(ftH<ftA?"2":"X");
            const norm = sel.replace(/\s+/g,"").toUpperCase();
            const m = norm.match(/([12X])[/\-]?([12X])/);
            if (m) status = (m[1]===ht && m[2]===ft)?"won":"lost";
          }
        }
        if (!status) continue;

        const conf = Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null;
        rows.push({ market: p.market || p.market_label || "", league: p.league?.name || "", status, conf });
      }

      const aggMarket = new Map(); // market -> {n,w,confSum,confN}
      const aggLeague = new Map(); // (market||league) -> {n,w}
      for (const r of rows) {
        const kM = r.market.toLowerCase();
        const kL = `${kM}||${(r.league||"").toLowerCase()}`;

        let m = aggMarket.get(kM);
        if (!m) { m = { market:r.market, n:0, w:0, confSum:0, confN:0 }; aggMarket.set(kM, m); }
        m.n += 1; if (r.status==="won") m.w += 1;
        if (Number.isFinite(r.conf)) { m.confSum += r.conf; m.confN += 1; }

        let l = aggLeague.get(kL);
        if (!l) { l = { market:r.market, league:r.league, n:0, w:0 }; aggLeague.set(kL, l); }
        l.n += 1; if (r.status==="won") l.w += 1;
      }

      const calibMarket = {};
      for (const [k, a] of aggMarket.entries()) {
        const act = laplaceRate(a.w, a.n);
        const pred = a.confN ? (a.confSum / a.confN) / 100 : null;
        const delta = (pred!=null) ? (act - pred) : 0;
        calibMarket[k] = { samples: a.n, win_rate_pp: toPP(act), avg_conf_pp: pred!=null?toPP(pred):null, delta_pp: toPP(delta) };
      }

      const calibLeague = {};
      for (const [k, a] of aggLeague.entries()) {
        if (a.n < 25) continue; // potreban uzorak
        const [mk, lgKey] = k.split("||");
        const m = aggMarket.get(mk);
        if (!m) continue;
        const actL = laplaceRate(a.w, a.n);
        const actM = laplaceRate(m.w, m.n);
        const diff = actL - actM;
        if (!calibLeague[mk]) calibLeague[mk] = {};
        calibLeague[mk][lgKey] = { samples: a.n, delta_vs_market_pp: toPP(diff) };
      }

      await kvSet("vb:learn:calib:latest", {
        built_at: new Date().toISOString(),
        window_days: 30,
        market: calibMarket,
        league: calibLeague
      });
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      snapshot_for: today,
      rev: newRev || 0
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
