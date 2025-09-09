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

const TZ = (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) || "Europe/Belgrade";
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
        body: valueString,
      });
      saved.push({ flavor:c.flavor, ok:r.ok });
    } catch (e) {
      saved.push({ flavor:c.flavor, ok:false, err:String(e?.message||e) });
    }
  }
  diag && (diag.writes = diag.writes || []).push({ key, saved });
  return saved;
}
const J = (s)=>{ try{ return JSON.parse(String(s||"")); }catch{return null;} };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object" && x) {
    // heuristike
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value === "string") {
      const v = J(x.value); if (Array.isArray(v)) return v;
      if (v && typeof v === "object") return arrFromAny(v);
    }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data)) return x.data;
  }
  if (typeof x === "string") {
    const v = J(x);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return arrFromAny(v);
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
  const s = (x?.kickoff || x?.datetime_local?.starting_at?.date_time || x?.datetime_local?.date_time || x?.fixture?.date || "").toString();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function implied(odd){ const o = Number(odd||0); if (!isFinite(o) || o<=0) return 0; return 1/o; }
function scoreForSort(x){ // kombinacija confidence + edge (prox: prob - implied)
  const mp = Math.max(0, Math.min(1, Number(x?.model_prob) || 0));
  const imp = implied(x?.odds?.price || x?.market_odds || 0);
  const edge = Math.max(0, mp - imp);
  return mp*100 + edge*100;
}
function dedupByFixture(arr){
  const bag = new Map();
  for (const it of (arr||[])) {
    const fid = Number(it?.fixture_id);
    if (!fid) continue;
    if (!bag.has(fid)) bag.set(fid, it);
    else {
      const a = bag.get(fid), b = it;
      const sa = scoreForSort(a), sb = scoreForSort(b);
      if (sb>sa) bag.set(fid,b);
    }
  }
  return Array.from(bag.values());
}
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
  const ts = Number(fx?.fixture?.timestamp || 0)*1000 || Date.parse(fx?.fixture?.date || 0) || 0;
  const kick = new Date(ts).toISOString();
  return {
    fixture_id: id,
    league: { id: fx?.league?.id, name: fx?.league?.name, country: fx?.league?.country, season: fx?.league?.season },
    league_name: fx?.league?.name,
    league_country: fx?.league?.country,
    teams: { home: fx?.teams?.home?.name, away: fx?.teams?.away?.name, home_id: fx?.teams?.home?.id, away_id: fx?.teams?.away?.id },
    home: fx?.teams?.home?.name, away: fx?.teams?.away?.name,
    datetime_local: { starting_at: { date_time: fx?.fixture?.date?.replace("T"," ").slice(0,16) } },
    kickoff: (fx?.fixture?.date || "").replace("T"," ").slice(0,16),
    kickoff_utc: kick,
    market: "1X2",
    market_label: "1X2",
    pick: null, pick_code: null, selection_label: null,
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
    }
  }
  return Array.from(bag.values());
}

/* -------- 1X2 from bookmakers -------- */
function best1x2FromBookmakers(bookmakers, minOdds = MIN_ODDS) {
  let best = null, books = 0;
  for (const b of bookmakers || []) {
    for (const bet of b.bets || []) {
      const nm = String(bet.name || "").toLowerCase();
      if (!(nm.includes("1x2") || nm.includes("1 x 2") || nm.includes("match winner") || nm.includes("winner"))) continue;
      books++;
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

/* -------- BTTS -------- */
function bestBTTS(bookmakers, minOdds = MIN_ODDS) {
  let best = null, books = 0;
  for (const b of bookmakers || []) {
    for (const bet of b.bets || []) {
      const nm = String(bet.name || "").toLowerCase();
      if (!(nm.includes("both teams to score") || nm.includes("btts"))) continue;
      books++;
      const vals = bet.values || [];
      const y = vals.find(v => /yes/i.test(v.value || ""));
      const n = vals.find(v => /no/i.test(v.value || ""));
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
      if (hasO && oO >= minOdds) cands.push({ sel:"Over 2.5",  odd:oO, prob:pO/S });
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

/* ---------------- build picks ---------------- */
function slotForKickoffISO(iso){
  const h = new Date(iso).toLocaleString("en-GB",{ hour:"2-digit", hour12:false, timeZone:TZ });
  const H = parseInt(h,10);
  return deriveSlot(H);
}

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

    // 2) Ako nema ničega, povuci SVE fixtur-e za YMD i filtriraj po slotu
    let baseArr = rawArr;
    if (!baseArr) {
      const fixtures = await fetchAllFixturesForDate(ymd);
      baseArr = fixtures.map(mapFixtureToItem).filter(x => slotForKickoffISO(x.kickoff_utc) === slot);
    }

    // 3) Filter out youth/primavera i sl.
    let items = (baseArr || []).filter(x => !isYouthOrBanned(x));

    // 4) Popuni 1X2/tickets iz API-Football odds (paralelizacija)
    const ids = items.map(x => x.fixture_id).filter(Boolean);
    const byId = new Map(items.map(x => [x.fixture_id, x]));
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
            league: meta.league, league_name: meta.league_name, league_country: meta.league_country,
            teams: meta.teams, home: meta.home, away: meta.away,
            kickoff: meta.kickoff, kickoff_utc: meta.kickoff_utc,
          } : { fixture_id: id };

          const btts = bestBTTS(bookmakers, MIN_ODDS);
          if (btts) {
            tickets.btts.push({
              ...base,
              market: "BTTS",
              market_label: "Both Teams To Score",
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
        } catch (e) {
          // ignore single-id failure
        }
      }
    };

    const CHUNK = Math.ceil((ids.length || 1) / LANES);
    const parts = [];
    for (let i=0;i<ids.length;i+=CHUNK) parts.push(ids.slice(i,i+CHUNK));
    await Promise.all(parts.map(lane));

    // 5) sortiraj i skrati
    const withPicks = (items || [])
      .filter(x => x?.odds?.price && x?.model_prob)
      .sort((a,b) =>
        (scoreForSort(b) - scoreForSort(a)) ||
        (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0))
      );
    const shortList = withPicks.slice(0, TARGET_N);

    // 6) Upis vbl/vb:day (bez brisanja union/last kad je prazno)
    const boxedFull  = JSON.stringify({ value: JSON.stringify(withPicks) });
    const boxedShort = JSON.stringify({ value: JSON.stringify(shortList) });

    const kSlot  = `vb:day:${ymd}:${slot}`;
    const kUnion = `vb:day:${ymd}:union`;
    const kLast  = `vb:day:${ymd}:last`;

    // 6a) Slot – uvek upiši snapshot slota (može biti i prazan)
    const s1 = await kvSET(kSlot, boxedFull, diag);

    // 6b) UNION = stari ∪ novi (dedup po fixture_id), ne prepisuj praznim
    const prevUnionRaw = (await kvGET(kUnion, diag)).raw;
    const prevUnionArr = arrFromAny(unpack(prevUnionRaw)) || [];
    const unionBag = new Map();
    for (const it of [...prevUnionArr, ...withPicks]) {
      const fid = Number(it?.fixture_id);
      if (!fid) continue;
      if (!unionBag.has(fid)) unionBag.set(fid, it);
    }
    const unionMerged = Array.from(unionBag.values());
    const s2 = await kvSET(kUnion, JSON.stringify({ value: JSON.stringify(unionMerged) }), diag);

    // 6c) LAST = ažuriraj samo ako ima novih pickova
    let s3 = null;
    if (withPicks.length > 0) {
      s3 = await kvSET(kLast, boxedFull, diag);
    }

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
    const seedRaw = (await kvGET(`hist:${ymd}`, diag)).raw;
    if (!seedRaw) {
      const seed = JSON.stringify({ value: JSON.stringify(merged) });
      await kvSET(`hist:${ymd}`, seed, diag);
    }

    // 9) TICKETS upis (slot)
    const sortTickets = (a,b) =>
      (b.confidence_pct - a.confidence_pct) ||
      (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0));

    const slotTickets = {
      btts: (tickets.btts||[]).sort(sortTickets).slice(0, TICKETS_PER_MARKET),
      ou25: (tickets.ou25||[]).sort(sortTickets).slice(0, TICKETS_PER_MARKET),
      htft: (tickets.htft||[]).sort(sortTickets).slice(0, TICKETS_PER_MARKET),
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
      slot,
      counts: { base: (baseArr||[]).length, after_filters: (items||[]).length, odds_called: called, filled },
      source: src || "built",
      ...(wantDebug ? { diag, vbl: {
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
