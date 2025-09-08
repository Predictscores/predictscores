// pages/api/cron/rebuild.js
// Rekonstrukcija "locked" feed-a za slot + upis dnevnih “tickets” (BTTS / OU2.5 / HT-FT).
// Slotovi (Europe/Belgrade): late 00–09, am 10–14, pm 15–23.
// Pravila: bez U-liga/Primavera/Youth, MIN_ODDS ≥ 1.50 (koristi se i za tickets).
// Upisi:
//  - vb:day:<YMD>:(<slot>|union|last)   [BOXED]
//  - vbl_full:<YMD>:<slot>               [PLAIN ARRAY]
//  - vbl:<YMD>:<slot>                    [PLAIN ARRAY, kratka lista]
//  - vb:day:<YMD>:combined               [BOXED Top-3 za dan]
//  - hist:<YMD> (ako je prazan)          [BOXED seed iz combined]
//  - tickets:<YMD>:<slot>                [PLAIN {btts,ou25,htft}]
//  - tickets:<YMD>                       [PLAIN merge & trim po marketu]

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";
const TARGET_N = 15;     // vbl kratka lista
const MIN_ODDS = 1.5;    // min kvota za SVE markete (1X2 + tickets)
const LANES = 4;         // paralelizacija za /odds
const TICKETS_PER_MARKET = Number(process.env.TICKETS_PER_MARKET || 4);

/* ---------------- KV (Vercel REST) ---------------- */
function kvCfgs() {
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw  = process.env.KV_REST_API_TOKEN || "";
  const ro  = process.env.KV_REST_API_READ_ONLY_TOKEN || "";
  const list = [];
  if (url && rw) list.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) list.push({ flavor: "vercel-kv:ro", url, token: ro });
  return list;
}
async function kvGET(key, diag) {
  for (const c of kvCfgs()) {
    try {
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store",
      });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(()=>null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status: ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` });
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, valueString, diag) {
  const saved = [];
  for (const c of kvCfgs().filter(x=>x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ value: valueString }),
      });
      if (r.ok) saved.push(c.flavor);
      diag && (diag.writes = diag.writes || []).push({ flavor:c.flavor, key, status:r.ok ? "ok" : `http-${r.status}` });
    } catch (e) {
      diag && (diag.writes = diag.writes || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return saved;
}

/* ---------------- parse helpers ---------------- */
function J(s){ try{ return JSON.parse(s); }catch{ return null; } }
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.value_bets)) return x.value_bets;
    if (Array.isArray(x.football)) return x.football;
    if (Array.isArray(x.list)) return x.list;
    if (Array.isArray(x.data)) return x.data;
  }
  return null;
}
function unpack(raw) {
  if (!raw || typeof raw !== "string") return null;
  let v1 = J(raw);
  if (Array.isArray(v1)) return v1;
  if (v1 && typeof v1 === "object" && "value" in v1) {
    if (Array.isArray(v1.value)) return v1.value;
    if (typeof v1.value === "string") {
      const v2 = J(v1.value);
      if (Array.isArray(v2)) return v2;
      if (v2 && typeof v2 === "object") return arrFromAny(v2);
    }
    return null;
  }
  if (v1 && typeof v1 === "object") return arrFromAny(v1);
  return null;
}

/* ---------------- time + slot helpers ---------------- */
function ymdInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone:tz, year:"numeric", month:"2-digit", day:"2-digit" });
  const p = fmt.formatToParts(d).reduce((a,x)=>(a[x.type]=x.value,a),{});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTZ(d=new Date(), tz=TZ){
  const fmt = new Intl.DateTimeFormat("en-GB",{ timeZone:tz, hour:"2-digit", hour12:false });
  return parseInt(fmt.format(d),10);
}
function deriveSlot(h){ if (h<10) return "late"; if (h<15) return "am"; return "pm"; }
function kickoffDate(x){
  const ts = x?.fixture?.timestamp ?? x?.timestamp;
  if (typeof ts === "number" && isFinite(ts)) {
    const d = new Date(ts * 1000);
    if (!isNaN(d.getTime())) return d;
  }
  const s =
    x?.kickoff_utc ||
    x?.datetime_local?.starting_at?.date_time ||
    x?.fixture?.date ||
    x?.datetime_utc ||
    x?.start_time?.utc ||
    x?.start_time;
  if (!s || typeof s !== "string") return null;
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}
function inSlotLocal(item, slot) {
  const d = kickoffDate(item);
  if (!d) return false;  // strogo: bez vremena ne prolazi
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}

/* ---------------- bans / filters ---------------- */
const YOUTH_PATTERNS = [
  /\bU(-|\s)?(17|18|19|20|21|22|23)\b/i,
  /\bPrimavera\b/i,
  /\bYouth\b/i,
];
function isYouthOrBanned(item){
  const ln = (item?.league_name || item?.league?.name || "").toString();
  const tnH = (item?.home || item?.teams?.home?.name || "").toString();
  const tnA = (item?.away || item?.teams?.away?.name || "").toString();
  const s = `${ln} ${tnH} ${tnA}`;
  return YOUTH_PATTERNS.some(rx => rx.test(s));
}

/* ---------------- API-Football ---------------- */
function afKey(){ return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || ""; }
async function afFetch(path, params={}){
  const key = afKey();
  if (!key) throw new Error("Missing API-Football key");
  const url = new URL(`https://v3.football.api-sports.io${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers:{ "x-apisports-key": key }, cache:"no-store" });
  const ct = r.headers.get("content-type")||"";
  const t = await r.text();
  if (!ct.includes("application/json")) throw new Error(`AF non-JSON ${r.status}: ${t.slice(0,120)}`);
  let j; try{ j=JSON.parse(t);}catch{ j=null; }
  if (!j) throw new Error("AF parse error");
  return j;
}
function mapFixtureToItem(fx){
  const id = Number(fx?.fixture?.id);
  const kick = fx?.fixture?.date || null;
  const ts   = fx?.fixture?.timestamp || null;
  const teams = { home: fx?.teams?.home?.name || null, away: fx?.teams?.away?.name || null };
  const league = fx?.league || null;
  return {
    fixture_id: id,
    league,
    league_name: league?.name || null,
    league_country: league?.country || null,
    teams,
    home: teams.home,
    away: teams.away,
    datetime_local: kick ? { starting_at: { date_time: String(kick).replace("T"," ").replace("Z","") } } : null,
    kickoff_utc: kick,
    timestamp: ts,
    // stub (popunićemo posle sa /odds)
    market: "1X2",
    selection_label: null,
    pick: null,
    pick_code: null,
    model_prob: null,
    confidence_pct: null,
    odds: null,
    fixture: { id, timestamp: ts, date: kick },
  };
}

/* -------- robust fixtures for date (handles backfill) -------- */
async function fetchAllFixturesForDate(ymd){
  const tries = [
    { tag: "date+tz",    params: { date: ymd, timezone: TZ } },
    { tag: "date",       params: { date: ymd } },
    { tag: "from-to+tz", params: { from: ymd, to: ymd, timezone: TZ } },
    { tag: "from-to",    params: { from: ymd, to: ymd } },
    { tag: "date+UTC",   params: { date: ymd, timezone: "UTC" } },
  ];
  const HARD_CAP_PAGES = 12;
  const bag = new Map();
  for (const t of tries) {
    let page = 1;
    while (page <= HARD_CAP_PAGES) {
      const jf = await afFetch("/fixtures", { ...t.params, page });
      const arr = Array.isArray(jf?.response) ? jf.response : [];
      for (const fx of arr) {
        const id = fx?.fixture?.id;
        if (id && !bag.has(id)) bag.set(id, fx);
      }
      const cur = Number(jf?.paging?.current || page);
      const tot = Number(jf?.paging?.total || page);
      if (!tot || cur >= tot) break;
      page++;
      await new Promise(r=>setTimeout(r, 120));
    }
    if (bag.size) break;
  }
  return Array.from(bag.values()).sort((a,b)=> new Date(a?.fixture?.date||0) - new Date(b?.fixture?.date||0));
}

/* -------- odds helpers -------- */
// 1X2 — već postoji:
function best1x2FromBookmakers(bookmakers, minOdds = MIN_ODDS) {
  let best = null, books = 0;
  for (const b of bookmakers || []) {
    books++;
    for (const bet of b.bets || []) {
      const name = String(bet.name || "").toLowerCase();
      if (!(name.includes("match winner") || name === "1x2" || name.includes("winner"))) continue;
      const vals = bet.values || [];
      const vH = vals.find(v => /^home$/i.test(v.value || ""));
      const vD = vals.find(v => /^draw$/i.test(v.value || ""));
      const vA = vals.find(v => /^away$/i.test(v.value || ""));
      if (!vH || !vD || !vA) continue;

      const oH = parseFloat(vH.odd), oD = parseFloat(vD.odd), oA = parseFloat(vA.odd);
      if (!isFinite(oH) || !isFinite(oD) || !isFinite(oA)) continue;

      const pH = 1/oH, pD = 1/oD, pA = 1/oA, S = pH + pD + pA;
      const cands = [
        { code:"1", label:"Home", odd:oH, prob:pH / S },
        { code:"X", label:"Draw", odd:oD, prob:pD / S },
        { code:"2", label:"Away", odd:oA, prob:pA / S },
      ].filter(c => c.odd >= minOdds);

      if (!cands.length) continue;
      cands.sort((a,b)=> b.prob - a.prob);
      const pick = cands[0];
      const chosen = {
        pick_code: pick.code,
        pick: pick.label,
        model_prob: pick.prob,
        odds: { price: pick.odd, books_count: 1 },
      };
      if (!best || chosen.model_prob > best.model_prob ||
         (Math.abs(chosen.model_prob - best.model_prob) < 1e-9 && chosen.odds.price < best.odds.price)) {
        best = chosen;
      }
    }
  }
  if (best) best.odds.books_count = Math.max(1, books);
  return best;
}

// BTTS (Yes/No)
function bestBTTS(bookmakers, minOdds = MIN_ODDS) {
  let best = null, books = 0;
  for (const b of bookmakers || []) {
    for (const bet of b.bets || []) {
      const nm = String(bet.name || "").toLowerCase();
      if (!(nm.includes("btts") || nm.includes("both teams"))) continue;
      books++;
      const vals = bet.values || [];
      const y = vals.find(v => /^yes$/i.test(v.value || ""));
      const n = vals.find(v => /^no$/i.test(v.value || ""));
      const oY = y ? parseFloat(y.odd) : NaN;
      const oN = n ? parseFloat(n.odd) : NaN;
      const hasY = isFinite(oY), hasN = isFinite(oN);
      if (!hasY && !hasN) continue;
      const pY = hasY ? 1/oY : 0, pN = hasN ? 1/oN : 0, S = pY + pN || 1;
      const cands = [];
      if (hasY && oY >= minOdds) cands.push({ sel:"Yes", odd:oY, prob:pY/S });
      if (hasN && oN >= minOdds) cands.push({ sel:"No",  odd:oN, prob:pN/S });
      if (!cands.length) continue;
      cands.sort((a,b)=> b.prob - a.prob);
      const pick = cands[0];
      if (!best || pick.prob > best.model_prob || (Math.abs(pick.prob-best.model_prob)<1e-9 && pick.odd<best.market_odds)) {
        best = { market:"BTTS", selection: pick.sel, market_odds: pick.odd, model_prob: pick.prob, bookmakers_count:1 };
      }
    }
  }
  if (best) best.bookmakers_count = Math.max(1, books);
  return best;
}

// OU 2.5 (Over/Under line 2.5)
function bestOU25(bookmakers, minOdds = MIN_ODDS) {
  let best = null, books = 0;
  const has25 = (s) => /\b2\.5\b/.test(String(s||""));
  for (const b of bookmakers || []) {
    for (const bet of b.bets || []) {
      const nm = String(bet.name || "").toLowerCase();
      if (!(nm.includes("over/under") || nm.includes("over under") || nm.includes("total"))) continue;
      const vals = bet.values || [];
      const candOver  = vals.find(v => /over/i.test(v.value || "") && (has25(v.value) || has25(v.handicap)));
      const candUnder = vals.find(v => /under/i.test(v.value || "") && (has25(v.value) || has25(v.handicap)));
      const oO = candOver  ? parseFloat(candOver.odd)  : NaN;
      const oU = candUnder ? parseFloat(candUnder.odd) : NaN;
      const hasO = isFinite(oO), hasU = isFinite(oU);
      if (!hasO && !hasU) continue;
      books++;
      const pO = hasO ? 1/oO : 0, pU = hasU ? 1/oU : 0, S = pO + pU || 1;
      const cands = [];
      if (hasO && oO >= minOdds) cands.push({ sel:"Over 2.5", odd:oO, prob:pO/S });
      if (hasU && oU >= minOdds) cands.push({ sel:"Under 2.5", odd:oU, prob:pU/S });
      if (!cands.length) continue;
      cands.sort((a,b)=> b.prob - a.prob);
      const pick = cands[0];
      if (!best || pick.prob > best.model_prob || (Math.abs(pick.prob-best.model_prob)<1e-9 && pick.odd<best.market_odds)) {
        best = { market:"OU 2.5", selection: pick.sel, market_odds: pick.odd, model_prob: pick.prob, bookmakers_count:1 };
      }
    }
  }
  if (best) best.bookmakers_count = Math.max(1, books);
  return best;
}

// HT/FT (Half-Time/Full-Time)
function bestHTFT(bookmakers, minOdds = MIN_ODDS) {
  let best = null, books = 0;
  const norm = (s) => String(s||"").toLowerCase();
  for (const b of bookmakers || []) {
    for (const bet of b.bets || []) {
      const nm = norm(bet.name);
      if (!(nm.includes("ht/ft") || nm.includes("half time/full time") || nm.includes("half-time/full-time"))) continue;
      books++;
      const vals = bet.values || [];
      const mapVal = (v) => {
        const val = norm(v.value);
        // pokušaj normalizacije u "Home/Draw/Away"
        const rep = val
          .replace(/\b(home)\b/ig, "Home")
          .replace(/\b(away)\b/ig, "Away")
          .replace(/\b(draw)\b/ig, "Draw")
          .replace(/\s+/g," ");
        return { label: v.value, odd: parseFloat(v.odd), rep };
      };
      const cand = vals.map(mapVal).filter(x => isFinite(x.odd) && x.odd >= minOdds);
      if (!cand.length) continue;
      // normalizovana verovatnoća po marginama (uzmi sve ponuđene ishode koje bookmaker daje)
      const probs = cand.map(c => ({ ...c, p: 1/c.odd }));
      const S = probs.reduce((a,x)=>a+x.p, 0) || 1;
      probs.forEach(x => x.p /= S);
      probs.sort((a,b)=> b.p - a.p);
      const pick = probs[0];
      if (!best || pick.p > best.model_prob || (Math.abs(pick.p-best.model_prob)<1e-9 && pick.odd<best.market_odds)) {
        best = { market:"HT/FT", selection: pick.label, market_odds: pick.odd, model_prob: pick.p, bookmakers_count:1 };
      }
    }
  }
  if (best) best.bookmakers_count = Math.max(1, books);
  return best;
}

function implied(probOrOdd){
  if (Number.isFinite(probOrOdd) && probOrOdd > 1.0) return 1/probOrOdd;
  if (Number.isFinite(probOrOdd) && probOrOdd >= 0 && probOrOdd <= 1) return probOrOdd;
  return null;
}

/* -------- enrich sa /odds (1X2 + TICKETS) -------- */
async function enrichWithOdds(items){
  const ids = items.map(x=>Number(x.fixture_id)).filter(Number.isFinite);
  const buckets = Array.from({length: LANES}, ()=>[]);
  ids.forEach((id,i)=> buckets[i%LANES].push(id));
  const byId = new Map(items.map(it=>[Number(it.fixture_id), it]));

  // tickets pool per slot
  const tickets = { btts: [], ou25: [], htft: [] };

  let called = 0, filled = 0;

  const lane = async subset=>{
    for (const id of subset) {
      try {
        const jo = await afFetch("/odds", { fixture: id });
        called++;
        const bookmakers = jo?.response?.[0]?.bookmakers || [];

        // 1X2
        const best = best1x2FromBookmakers(bookmakers, MIN_ODDS);
        if (best) {
          const it = byId.get(id);
          if (it) {
            it.selection_label = best.pick;
            it.pick = best.pick;
            it.pick_code = best.pick_code || (best.pick === "Home" ? "1" : best.pick === "Draw" ? "X" : "2");
            it.model_prob = best.model_prob;
            it.confidence_pct = Math.round(100 * best.model_prob);
            it.odds = { price: best.odds.price, books_count: best.odds.books_count || 1 };
            filled++;
          }
        }

        // TICKETS (BTTS / OU 2.5 / HT-FT)
        const meta = byId.get(id); // sadrži league/teams/kickoff_utc
        const base = meta ? {
          fixture_id: id,
          league: meta.league || null,
          league_name: meta?.league?.name || null,
          teams: meta.teams || null,
          home: meta?.teams?.home?.name || null,
          away: meta?.teams?.away?.name || null,
          datetime_local: meta?.datetime_local || null,
          kickoff_utc: meta?.kickoff_utc || null,
        } : { fixture_id:id };

        const btts = bestBTTS(bookmakers, MIN_ODDS);
        if (btts) {
          tickets.btts.push({
            ...base,
            market: "BTTS",
            market_label: "BTTS",
            selection: btts.selection,
            market_odds: btts.market_odds,
            model_prob: btts.model_prob,
            implied_prob: implied(btts.market_odds),
            confidence_pct: Math.round(100 * btts.model_prob),
            bookmakers_count: btts.bookmakers_count || 1,
          });
        }
        const ou25 = bestOU25(bookmakers, MIN_ODDS);
        if (ou25) {
          tickets.ou25.push({
            ...base,
            market: "OU 2.5",
            market_label: "Over/Under 2.5",
            selection: ou25.selection,
            market_odds: ou25.market_odds,
            model_prob: ou25.model_prob,
            implied_prob: implied(ou25.market_odds),
            confidence_pct: Math.round(100 * ou25.model_prob),
            bookmakers_count: ou25.bookmakers_count || 1,
          });
        }
        const htft = bestHTFT(bookmakers, MIN_ODDS);
        if (htft) {
          tickets.htft.push({
            ...base,
            market: "HT/FT",
            market_label: "HT-FT",
            selection: htft.selection,
            market_odds: htft.market_odds,
            model_prob: htft.model_prob,
            implied_prob: implied(htft.market_odds),
            confidence_pct: Math.round(100 * htft.model_prob),
            bookmakers_count: htft.bookmakers_count || 1,
          });
        }

      } catch { /* skip */ }
      await new Promise(r=>setTimeout(r,120));
    }
  };

  await Promise.all(buckets.map(lane));
  return { called, filled, tickets };
}

/* -------- scoring & helpers -------- */
function scoreForSort(it) {
  const c = Number(it?.confidence_pct ?? 0);
  const p = Number(it?.model_prob ?? 0);
  const ev = Number(it?.ev ?? it?.edge ?? (Number.isFinite(it?.market_odds) && Number.isFinite(it?.model_prob) ? (it.model_prob * it.market_odds - 1) : 0));
  return c * 10000 + p * 100 + ev;
}
function dedupByFixture(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr || []) {
    const id = Number(it?.fixture_id ?? it?.fixture?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}
function sortTickets(a,b){
  return (b.confidence_pct - a.confidence_pct) ||
         (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0));
}

/* ---------------- main ---------------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  try {
    const now = new Date();
    const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
    const wantDebug = String(q.debug ?? "") === "1";
    const diag = wantDebug ? {} : null;

    // 1) Kandidati iz KV (vb:day -> vbl_full -> vbl)
    const prefer = [
      `vb:day:${ymd}:${slot}`,
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
    ];
    let rawArr = null, src = null;
    for (const k of prefer) {
      const { raw } = await kvGET(k, diag);
      const arr = arrFromAny(unpack(raw));
      if (arr && arr.length) { rawArr = arr; src = k; break; }
    }

    // 2) Ako nema ništa → fixtures za YMD (ROBUST)
    let items;
    if (rawArr && rawArr.length) {
      items = rawArr;
    } else {
      const fixtures = await fetchAllFixturesForDate(ymd);
      const resp = Array.isArray(fixtures) ? fixtures : [];
      items = resp.map(mapFixtureToItem);
      src = "fallback:af-fixtures";
    }

    // 3) Slot + youth/primavera ban + sort po vremenu (max 60)
    const slotFiltered = items
      .filter(x => inSlotLocal(x, slot))
      .filter(x => !isYouthOrBanned(x))
      .sort((a,b)=> (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0)))
      .slice(0, 60);

    // 4) /odds enrich (1X2 + tickets)
    const { called, filled, tickets } = await enrichWithOdds(slotFiltered);

    // 5) 1X2 shortlist
    const withPicks = slotFiltered
      .filter(x => x.pick && x.odds && Number(x.odds.price) >= MIN_ODDS);

    withPicks.sort((a,b)=>
      (b.confidence_pct - a.confidence_pct) ||
      (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0))
    );
    const shortList = withPicks.slice(0, TARGET_N);

    // 6) Upis vbl/vb:day
    const boxedFull = JSON.stringify({ value: JSON.stringify(withPicks) });
    const boxedShort = JSON.stringify({ value: JSON.stringify(shortList) });

    const kSlot   = `vb:day:${ymd}:${slot}`;
    const kUnion  = `vb:day:${ymd}:union`;
    const kLast   = `vb:day:${ymd}:last`;

    const s1 = await kvSET(kSlot,  boxedFull, diag);
    const s2 = await kvSET(kUnion, boxedFull, diag);
    const s3 = await kvSET(kLast,  boxedFull, diag);

    const s4 = await kvSET(`vbl_full:${ymd}:${slot}`, JSON.stringify(withPicks), diag);
    const s5 = await kvSET(`vbl:${ymd}:${slot}`,      JSON.stringify(shortList), diag);

    // 7) combined (Top-3 za ceo dan; BOXED)
    const top3ThisSlot = withPicks.slice(0, 3);
    const prevRaw = (await kvGET(`vb:day:${ymd}:combined`, diag)).raw;
    const prevArr = arrFromAny(unpack(prevRaw)) || [];
    const merged = dedupByFixture([...prevArr, ...top3ThisSlot])
      .sort((a,b) => scoreForSort(b) - scoreForSort(a))
      .slice(0, 3);
    const boxedCombined = JSON.stringify({ value: JSON.stringify(merged) });
    const s6 = await kvSET(`vb:day:${ymd}:combined`, boxedCombined, diag);

    // 8) seed hist:<YMD> ako je prazan
    const histKey = `hist:${ymd}`;
    const histRaw = (await kvGET(histKey, diag)).raw;
    const histArr = arrFromAny(unpack(histRaw)) || [];
    if (histArr.length === 0 && merged.length > 0) {
      await kvSET(histKey, boxedCombined, diag);
    }

    // 9) TICKETS upis: per-slot i dnevni merge
    // sort + trim po marketu za slot:
    const slotTickets = {
      btts: (tickets.btts || []).sort(sortTickets).slice(0, TICKETS_PER_MARKET),
      ou25: (tickets.ou25 || []).sort(sortTickets).slice(0, TICKETS_PER_MARKET),
      htft: (tickets.htft || []).sort(sortTickets).slice(0, TICKETS_PER_MARKET),
    };
    const s7 = await kvSET(`tickets:${ymd}:${slot}`, JSON.stringify(slotTickets), diag);

    // dnevni merge (uzmi postojeće, spoji, dedup po fixture_id, sort, trim)
    const dayRaw = (await kvGET(`tickets:${ymd}`, diag)).raw;
    const dayObj = dayRaw ? J(dayRaw) : { btts:[], ou25:[], htft:[] };
    const mergeCat = (oldArr, addArr) => {
      const bag = new Map();
      for (const it of [...(oldArr||[]), ...(addArr||[])]) {
        const fid = Number(it?.fixture_id);
        if (!fid) continue;
        if (!bag.has(fid)) bag.set(fid, it);
        else {
          // zadrži jači (viši confidence, pa raniji kickoff)
          const a = bag.get(fid), b = it;
          if (sortTickets(b,a) < 0) bag.set(fid, b);
        }
      }
      return Array.from(bag.values()).sort(sortTickets).slice(0, TICKETS_PER_MARKET);
    };
    const mergedDayTickets = {
      btts: mergeCat(dayObj.btts, slotTickets.btts),
      ou25: mergeCat(dayObj.ou25, slotTickets.ou25),
      htft: mergeCat(dayObj.htft, slotTickets.htft),
    };
    const s8 = await kvSET(`tickets:${ymd}`, JSON.stringify(mergedDayTickets), diag);

    return res.status(200).json({
      ok: true,
      ymd,
      mutated: true,
      counts: { union: withPicks.length, last: withPicks.length, combined: withPicks.length },
      source: src,
      saved_backends: Array.from(new Set([...(s1||[]), ...(s2||[]), ...(s3||[]), ...(s4||[]), ...(s5||[]), ...(s6||[]), ...(s7||[]), ...(s8||[])])),
      ...(wantDebug ? { debug: {
        slot,
        odds_called: called,
        odds_filled: filled,
        kept: withPicks.length,
        returned: shortList.length,
        tickets: {
          slot_btts: (slotTickets.btts||[]).length,
          slot_ou25: (slotTickets.ou25||[]).length,
          slot_htft: (slotTickets.htft||[]).length,
        }
      } } : {})
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
