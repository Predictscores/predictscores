// FILE: pages/api/locked-floats.js
export const config = { api: { bodyParser: false } };

// ---- KV helpers
function kvCreds() {
  return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
}
async function kvGet(key) {
  const { url, token } = kvCreds();
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const { result } = await r.json();
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  const { url, token } = kvCreds();
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}
async function kvIncr(key) {
  const { url, token } = kvCreds();
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
async function kvSetNX(key, ttlSec = 3600) {
  const { url, token } = kvCreds();
  if (!url || !token) return false;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(["SET", key, "1", "NX", "EX", ttlSec]),
  }).catch(() => null);
  if (!r) return false;
  const j = await r.json().catch(() => ({}));
  return j?.result === "OK";
}

// ---- AF helpers
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

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const LIMIT = Math.max(1, Number(process.env.VB_LIMIT || 15));
const MAX_PER_LEAGUE = Math.max(1, Number(process.env.VB_MAX_PER_LEAGUE || 2));

function belgradeNow() { return new Date(new Date().toLocaleString("en-US", { timeZone: TZ })); }
function beogradYMD(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  return fmt.format(d);
}
function hmNow() {
  const fmt = new Intl.DateTimeFormat("sv-SE",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false});
  return fmt.format(new Date());
}
function parseISO(x){ try{ return new Date(String(x).replace(" ","T")).getTime(); }catch{ return NaN; } }
function median(arr){ return arr.length ? arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length/2)] : null; }
function isUEFA(name = "") {
  const n = String(name).toLowerCase();
  return n.includes("champions league") || n.includes("europa league") || n.includes("conference league");
}

function withinMinutes(ts, minutes) {
  const asOf = typeof ts === "string" ? Date.parse(ts) : Number(ts);
  if (!Number.isFinite(asOf)) return true;
  const diffMin = (Date.now() - asOf) / 60000;
  return diffMin <= minutes;
}

async function readSnapshot(today) {
  const arr = await kvGet(`vb:day:${today}:last`);
  return Array.isArray(arr) ? arr.slice() : [];
}
async function writeSnapshot(today, arr) {
  await kvSet(`vb:day:${today}:last`, arr.slice());
  await kvIncr(`vb:day:${today}:rev`);
}

async function updateFloats(today, capHot=15, hotThresholdMin=45, coldThresholdMin=120) {
  const snap = await readSnapshot(today);
  if (!snap.length) return { updated: 0, total_locked: 0 };

  // Sortiraj po vremenu (najskoriji prvi)
  snap.sort((a,b) => parseISO(a?.datetime_local?.starting_at?.date_time) - parseISO(b?.datetime_local?.starting_at?.date_time));

  let updated = 0;
  const hour = Number(hmNow().split(":")[0] || 0);
  const minBookies = (hour>=10 && hour<=21) ? 4 : 3;

  for (const p of snap) {
    if (updated >= capHot) break;
    const iso = p?.datetime_local?.starting_at?.date_time?.replace(" ","T");
    if (!iso) continue;
    const minsTo = Math.round((new Date(iso).getTime() - Date.now())/60000);
    const float = await kvGet(`vb:float:${p.fixture_id}`);

    const needHot = minsTo<=240; // < 4h
    const threshold = needHot ? hotThresholdMin : coldThresholdMin;
    const fresh = float && withinMinutes(float.as_of, threshold);
    if (fresh) continue;

    // AF /odds?fixture=...
    let books = [];
    try {
      const resp = await afGet(`/odds?fixture=${p.fixture_id}`);
      const row = resp?.[0] || {};
      books = row.bookmakers || [];
    } catch {}

    const acc = { "1":[], "X":[], "2":[] };
    let usedBooks = 0;
    for (const b of books) {
      let used = false;
      for (const bet of (b?.bets||[])) {
        const name=(bet?.name||"").toLowerCase();
        if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
          for (const v of bet.values||[]) {
            const lbl=(v?.value||"").toUpperCase(); const odd=Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl==="HOME"||lbl==="1") acc["1"].push(odd), used=true;
            if (lbl==="DRAW"||lbl==="X") acc["X"].push(odd), used=true;
            if (lbl==="AWAY"||lbl==="2") acc["2"].push(odd), used=true;
          }
        }
      }
      if (used) usedBooks++;
    }

    if (usedBooks < minBookies) continue;

    const o1 = median(acc["1"]), oX = median(acc["X"]), o2 = median(acc["2"]);
    const market_odds = (() => {
      const sel = String(p.selection||"").toUpperCase();
      if (sel==="1"||sel.includes("HOME")) return o1;
      if (sel==="2"||sel.includes("AWAY")) return o2;
      if (sel==="X"||sel.includes("DRAW")) return oX;
      return Number.isFinite(p.market_odds)?p.market_odds:null;
    })();

    const implied = Number.isFinite(market_odds) && market_odds>0 ? 1/market_odds : (Number.isFinite(p.implied_prob)?p.implied_prob:null);
    const model = Number.isFinite(p.model_prob) ? p.model_prob : null;
    const ev = (model!=null && Number.isFinite(market_odds)) ? (market_odds*model - 1) : (Number.isFinite(p.ev)?p.ev:null);

    // movement (pp): uporedi sa prethodnim implied-om
    const prevImp = float?.implied;
    const movePct = (prevImp!=null && implied!=null) ? Math.round((implied - prevImp) * 10000)/100 : 0;

    await kvSet(`vb:float:${p.fixture_id}`, {
      as_of: new Date().toISOString(),
      odds: Number.isFinite(market_odds)?market_odds:null,
      implied: Number.isFinite(implied)?implied:null,
      ev: Number.isFinite(ev)?ev:null,
      confidence: Number.isFinite(p.confidence_pct) ? Number(p.confidence_pct) : null,
      bookmakers_count: usedBooks,
      movement_pct: movePct
    });
    updated++;
  }

  return { updated, total_locked: snap.length };
}

/** Light PREVIEW (noćni mini-feed) – K≈6, bez težih poziva */
async function buildPreview(today, horizonHours=8, passCap=20, limit=6) {
  const now = belgradeNow();
  const endMs = now.getTime() + horizonHours*3600*1000;

  // fixtures by local d-1, d, d+1 (filter by time window)
  const dNow = beogradYMD(now);
  const dPrev = beogradYMD(new Date(now.getTime() - 24*3600*1000));
  const dNext = beogradYMD(new Date(now.getTime() + 24*3600*1000));
  const days = [dPrev, dNow, dNext];

  let fixtures = [];
  for (const ymd of days) {
    try {
      const af = await afGet(`/fixtures?date=${ymd}`);
      for (const f of af) {
        const t = new Date(f?.fixture?.date).getTime();
        if (!Number.isFinite(t)) continue;
        if (t>now.getTime() && t<=endMs) {
          fixtures.push({
            fixture_id: f?.fixture?.id,
            league:{ id:f?.league?.id, name:f?.league?.name, country:f?.league?.country, season:f?.league?.season },
            teams:{ home:{ id:f?.teams?.home?.id, name:f?.teams?.home?.name }, away:{ id:f?.teams?.away?.id, name:f?.teams?.away?.name } },
            datetime_local:{ starting_at:{ date_time: f?.fixture?.date }}
          });
        }
      }
    } catch {}
  }

  // quick pass: predictions -> izaberi 1X2 selekciju
  const picks = [];
  fixtures.sort((a,b)=> (a?.league?.name||"").localeCompare(b?.league?.name||""));
  for (const f of fixtures.slice(0, passCap)) {
    try {
      const pr = await afGet(`/predictions?fixture=${f.fixture_id}`);
      const r = pr?.[0]?.predictions || pr?.[0] || {};
      const clean = v => typeof v==="string"?parseFloat(v)/100:Number(v);
      let p1=clean(r?.percent?.home), px=clean(r?.percent?.draw), p2=clean(r?.percent?.away);
      const tot=[p1,px,p2].filter(Number.isFinite).reduce((a,b)=>a+b,0)||0;
      if (tot>0){ p1=(p1||0)/tot; px=(px||0)/tot; p2=(p2||0)/tot; }
      const map={ "1":p1||0, "X":px||0, "2":p2||0 };
      const sel=Object.keys(map).sort((a,b)=>map[b]-map[a])[0]||"1";
      const prob = map[sel]||0;

      const oddsResp = await afGet(`/odds?fixture=${f.fixture_id}`);
      const books = oddsResp?.[0]?.bookmakers || [];
      const acc = { "1":[], "X":[], "2":[] };
      let used = 0;
      for (const b of books) {
        let u = false;
        for (const bet of (b?.bets||[])) {
          const name=(bet?.name||"").toLowerCase();
          if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
            for (const v of bet.values||[]) {
              const lbl=(v?.value||"").toUpperCase(); const odd=Number(v?.odd);
              if (!Number.isFinite(odd)) continue;
              if (lbl==="HOME"||lbl==="1") acc["1"].push(odd), u=true;
              if (lbl==="DRAW"||lbl==="X") acc["X"].push(odd), u=true;
              if (lbl==="AWAY"||lbl==="2") acc["2"].push(odd), u=true;
            }
          }
        }
        if (u) used++;
      }
      const hour = Number(hmNow().split(":")[0]||0);
      const minBookies = (hour>=10 && hour<=21) ? 4 : 3;
      if (used < minBookies) continue;

      const odds = sel==="1"?median(acc["1"]):sel==="2"?median(acc["2"]):median(acc["X"]);
      if (!Number.isFinite(odds) || odds<=0) continue;
      const implied = 1/odds;
      const edge_pp = (prob - implied) * 100;
      const ev = odds*prob - 1;

      picks.push({
        fixture_id: f.fixture_id, teams: f.teams, league: f.league,
        datetime_local: f.datetime_local,
        market: "1X2", market_label: "1X2",
        selection: sel,
        type: "MODEL+ODDS",
        model_prob: prob,
        market_odds: odds,
        implied_prob: implied,
        edge: Number.isFinite(ev)?ev:null,
        edge_pp: Math.round(edge_pp*10)/10,
        ev,
        movement_pct: 0,
        confidence_pct: Math.round(prob*100), // bazno, kasnije ide kalibracija
        bookmakers_count: used,
        explain: { summary: `Model ${Math.round(prob*100)}% vs ${Math.round(implied*100)}% · EV ${Math.round(ev*1000)/10}% · Bookies ${used}`, bullets: [] }
      });
    } catch {}
  }

  // sortiraj po confidence → EV, i uzmi limit
  picks.sort((a,b)=>{
    const ca = Number(a.confidence_pct||0), cb = Number(b.confidence_pct||0);
    if (cb!==ca) return cb - ca;
    const eva = Number.isFinite(a.ev)?a.ev:-Infinity, evb=Number.isFinite(b.ev)?b.ev:-Infinity;
    return evb - eva;
  });

  await kvSet(`vb:preview:${today}:last`, picks.slice(0, limit));
  return { preview_saved: Math.min(limit, picks.length) };
}

/** Scout + swap-in (Smart 45):
 * - gleda 4h prozor za mečeve koji NISU već u snapshotu
 * - MIN_BOOKIES dinamičan (4 u 10–21h)
 * - ubaci max 2 bolja kandidata po ciklusu, max 6 dnevno
 * - sticky 45 min (ne vraćamo odmah)
 */
async function scoutAndSwap(today) {
  // 45-min slot lock (da ne duplira)
  const slot = Math.floor(Date.now() / (45*60*1000));
  const got = await kvSetNX(`vb:scout:${today}:${slot}`, 50*60); // ~50 min
  if (!got) return { swaps: 0, reason: "locked" };

  const base = await readSnapshot(today);
  if (!base.length) return { swaps: 0, reason: "no snapshot" };

  const idsPinned = new Set(base.map(p=>p.fixture_id));

  // window 4h
  const now = belgradeNow();
  const end = new Date(now.getTime() + 4*3600*1000).getTime();

  const dNow = beogradYMD(now);
  const dPrev = beogradYMD(new Date(now.getTime() - 24*3600*1000));
  const dNext = beogradYMD(new Date(now.getTime() + 24*3600*1000));
  const days = [dPrev, dNow, dNext];

  let candFixtures = [];
  for (const ymd of days) {
    try {
      const af = await afGet(`/fixtures?date=${ymd}`);
      for (const f of af) {
        const t = new Date(f?.fixture?.date).getTime();
        if (!Number.isFinite(t)) continue;
        if (t>now.getTime() && t<=end) {
          const id = Number(f?.fixture?.id);
          if (!idsPinned.has(id)) {
            candFixtures.push({
              fixture_id: id,
              league:{ id:f?.league?.id, name:f?.league?.name, country:f?.league?.country, season:f?.league?.season },
              teams:{ home:{ id:f?.teams?.home?.id, name:f?.teams?.home?.name }, away:{ id:f?.teams?.away?.id, name:f?.teams?.away?.name } },
              datetime_local:{ starting_at:{ date_time: f?.fixture?.date }}
            });
          }
        }
      }
    } catch {}
  }

  // quick predictions + odds (1X2) za do 10 kandidata
  const hour = Number(hmNow().split(":")[0] || 0);
  const minBookies = (hour>=10 && hour<=21) ? 4 : 3;

  const cands = [];
  for (const f of candFixtures.slice(0, 20)) {
    try {
      const pr = await afGet(`/predictions?fixture=${f.fixture_id}`);
      const r = pr?.[0]?.predictions || pr?.[0] || {};
      const clean = v => typeof v==="string"?parseFloat(v)/100:Number(v);
      let p1=clean(r?.percent?.home), px=clean(r?.percent?.draw), p2=clean(r?.percent?.away);
      const tot=[p1,px,p2].filter(Number.isFinite).reduce((a,b)=>a+b,0)||0;
      if (tot>0){ p1=(p1||0)/tot; px=(px||0)/tot; p2=(p2||0)/tot; }
      const map={ "1":p1||0, "X":px||0, "2":p2||0 };
      const sel=Object.keys(map).sort((a,b)=>map[b]-map[a])[0]||"1";
      const prob = map[sel]||0;

      const oddsResp = await afGet(`/odds?fixture=${f.fixture_id}`);
      const books = oddsResp?.[0]?.bookmakers || [];
      const acc = { "1":[], "X":[], "2":[] };
      let used = 0;
      for (const b of books) {
        let u=false;
        for (const bet of (b?.bets||[])) {
          const name=(bet?.name||"").toLowerCase();
          if (name.includes("match winner") || name.includes("1x2") || name.includes("full time result")) {
            for (const v of bet.values||[]) {
              const lbl=(v?.value||"").toUpperCase(); const odd=Number(v?.odd);
              if (!Number.isFinite(odd)) continue;
              if (lbl==="HOME"||lbl==="1") acc["1"].push(odd), u=true;
              if (lbl==="DRAW"||lbl==="X") acc["X"].push(odd), u=true;
              if (lbl==="AWAY"||lbl==="2") acc["2"].push(odd), u=true;
            }
          }
        }
        if (u) used++;
      }
      if (used < minBookies) continue;

      const odds = sel==="1"?median(acc["1"]):sel==="2"?median(acc["2"]):median(acc["X"]);
      if (!Number.isFinite(odds) || odds<=0) continue;
      const implied = 1/odds;
      const edge_pp = (prob - implied) * 100;
      const ev = odds*prob - 1;

      if (!(ev>0 && edge_pp>=2.0)) continue; // prag za hotlist

      cands.push({
        fixture_id: f.fixture_id, teams: f.teams, league: f.league,
        datetime_local: f.datetime_local,
        market: "1X2", market_label: "1X2",
        selection: sel,
        type: "MODEL+ODDS",
        model_prob: prob,
        market_odds: odds,
        implied_prob: implied,
        edge: Number.isFinite(ev)?ev:null,
        edge_pp: Math.round(edge_pp*10)/10,
        ev,
        movement_pct: 0,
        confidence_pct: Math.round(prob*100),
        bookmakers_count: used,
        explain: { summary: `Model ${Math.round(prob*100)}% vs ${Math.round(implied*100)}% · EV ${Math.round(ev*1000)/10}% · Bookies ${used}`, bullets: [] }
      });
    } catch {}
  }

  if (!cands.length) return { swaps: 0, reason: "no candidates" };

  // nadji 2 najslabija u snapshotu
  const baseSorted = base.slice().sort((a,b)=>{
    const ca = Number(a.confidence_pct||0), cb = Number(b.confidence_pct||0);
    if (ca!==cb) return ca - cb;
    const eva = Number.isFinite(a.ev)?a.ev:-Infinity, evb=Number.isFinite(b.ev)?b.ev:-Infinity;
    return eva - evb;
  });

  // counts by league (max 2 po ligi, UEFA izuzetak)
  const cntByLeague = (arr) => {
    const m = new Map();
    for (const p of arr) {
      const key = String(p?.league?.id ?? p?.league?.name ?? "").toLowerCase();
      const n = m.get(key) || 0;
      m.set(key, n+1);
    }
    return m;
  };

  let swaps = 0;
  const maxSwapsPerCycle = 2;

  for (const hot of cands.sort((a,b)=>{
    const ea = Number.isFinite(a.ev)?a.ev:-Infinity, eb=Number.isFinite(b.ev)?b.ev:-Infinity;
    if (eb!==ea) return eb - ea;
    return (b.confidence_pct||0) - (a.confidence_pct||0);
  })) {
    if (swaps >= maxSwapsPerCycle) break;

    const worst = baseSorted.shift();
    if (!worst) break;

    // uslovi swap-a
    const confGap = (hot.confidence_pct||0) - (worst.confidence_pct||0);
    const edgeGap = (hot.edge_pp||-999) - (worst.edge_pp||-999);

    const leagueName = hot?.league?.name || "";
    const key = String(hot?.league?.id ?? hot?.league?.name ?? "").toLowerCase();
    const counts = cntByLeague(base);
    const currentCnt = counts.get(key) || 0;
    const violatesCap = (!isUEFA(leagueName) && currentCnt >= MAX_PER_LEAGUE);

    if ((confGap < 4 && edgeGap < 1.0) || violatesCap) {
      // odbaci ovaj hot, vrati worst na listu da se možda uporedi sa sledećim
      baseSorted.unshift(worst);
      continue;
    }

    // izvrši swap
    const idx = base.findIndex(p => (p.fixture_id===worst.fixture_id));
    if (idx>=0) {
      base[idx] = hot;
      swaps++;
    }
  }

  if (swaps>0) {
    await writeSnapshot(today, base);
  }
  return { swaps };
}

export default async function handler(req, res) {
  try {
    const today = beogradYMD();
    const doPreview = String(req.query.preview||"") === "1";

    if (doPreview) {
      const ok = await kvSetNX(`vb:preview:lock:${today}`, 15*60); // ~15 min lock
      if (!ok) return res.status(200).json({ preview: "skipped (locked)" });
      const out = await buildPreview(today, 8, 20, 6);
      return res.status(200).json({ ok: true, ...out });
    }

    // 1) FLOTS (45 min za <4h, 120 min ostali)
    const floats = await updateFloats(today, 15, 45, 120);

    // 2) SCOUT + SWAP (Smart 45)
    const scout = await scoutAndSwap(today);

    return res.status(200).json({ ok: true, floats, scout });
  } catch (e) {
    return res.status(500).json({ error: String(e&&e.message||e) });
  }
}
