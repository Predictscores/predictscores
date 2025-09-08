// pages/api/cron/rebuild.js
// Rekonstrukcija "locked" feed-a za slot.
// Slotovi (Europe/Belgrade): late 00–09, am 10–14, pm 15–23.
// Pravila: bez U-liga/Primavera/Youth, MIN_ODDS ≥ 1.50, obavezno popunjen pick/odds/confidence preko /odds.
// Upis: vb:day:<YMD>:<slot> (+union,+last) [boxed] + mirror vbl_full:<YMD>:<slot> i vbl:<YMD>:<slot> [plain array].
// NOVO: održava i vb:day:<YMD>:combined (Top-3 za ceo dan).

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";
const TARGET_N = 15;     // koliko vracamo u kratkoj listi (vbl)
const MIN_ODDS = 1.5;    // minimalna dozvoljena kvota za izabrani ishod
const LANES = 4;         // paralelizacija za /odds

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
  if (!d) return false;  // STROGO: bez vremena ne prolazi
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
    // stub polja (popunićemo posle sa /odds)
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
// Biramo NAJVEROVATNIJI ishod među onima sa kvotom >= minOdds.
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

async function enrichWithOdds(items){
  const ids = items.map(x=>Number(x.fixture_id)).filter(Number.isFinite);
  const buckets = Array.from({length: LANES}, ()=>[]);
  ids.forEach((id,i)=> buckets[i%LANES].push(id));
  const byId = new Map(items.map(it=>[Number(it.fixture_id), it]));
  let called = 0, filled = 0;

  const lane = async subset=>{
    for (const id of subset) {
      try {
        const jo = await afFetch("/odds", { fixture: id });
        called++;
        const bookmakers = jo?.response?.[0]?.bookmakers || [];
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
      } catch { /* skip */ }
      await new Promise(r=>setTimeout(r,120));
    }
  };

  await Promise.all(buckets.map(lane));
  return { called, filled };
}

/* -------- scoring for combined -------- */
function scoreForSort(it) {
  const c = Number(it?.confidence_pct ?? 0);
  const p = Number(it?.model_prob ?? 0);
  const ev = Number(it?.ev ?? it?.edge ?? 0);
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

/* ---------------- main ---------------- */
export default async function handler(req, res) {
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const now = new Date();
  const ymd = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
  const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
  const wantDebug = String(q.debug ?? "") === "1";
  const diag = wantDebug ? {} : null;

  try {
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

    // 3) Strogi slot + youth/primavera ban + sort po vremenu (max 60)
    const slotFiltered = items
      .filter(x => inSlotLocal(x, slot))
      .filter(x => !isYouthOrBanned(x))
      .sort((a,b)=> (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0)))
      .slice(0, 60);

    // 4) Popuni /odds samo za slotirane (malo poziva)
    const { called, filled } = await enrichWithOdds(slotFiltered);

    // 5) Odbaci sve bez pick-a ili sa kvotom < MIN_ODDS
    const withPicks = slotFiltered
      .filter(x => x.pick && x.odds && Number(x.odds.price) >= MIN_ODDS);

    // 6) Sort: najpre confidence, zatim kickoff; preseci na TARGET_N (za kratku listu)
    withPicks.sort((a,b)=>
      (b.confidence_pct - a.confidence_pct) ||
      (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0))
    );
    const shortList = withPicks.slice(0, TARGET_N);

    // 7) Upis u vb:day:* (BOXED) + mirror u vbl_full (plain, full) i vbl (plain, short)
    const boxedFull = JSON.stringify({ value: JSON.stringify(withPicks) });
    const boxedShort = JSON.stringify({ value: JSON.stringify(shortList) });

    const kSlot   = `vb:day:${ymd}:${slot}`;
    const kUnion  = `vb:day:${ymd}:union`;
    const kLast   = `vb:day:${ymd}:last`;

    const s1 = await kvSET(kSlot,  boxedFull, diag);
    const s2 = await kvSET(kUnion, boxedFull, diag);
    const s3 = await kvSET(kLast,  boxedFull, diag);

    // mirror (reader-friendly: plain arrays)
    const s4 = await kvSET(`vbl_full:${ymd}:${slot}`, JSON.stringify(withPicks), diag);
    const s5 = await kvSET(`vbl:${ymd}:${slot}`,      JSON.stringify(shortList), diag);

    // 8) NOVO — održavaj vb:day:<YMD>:combined (Top-3 za ceo dan; merge+trim)
    const top3ThisSlot = withPicks.slice(0, 3);
    const prevRaw = (await kvGET(`vb:day:${ymd}:combined`, diag)).raw;
    const prevArr = arrFromAny(unpack(prevRaw)) || [];
    const merged = dedupByFixture([...prevArr, ...top3ThisSlot])
      .sort((a,b) => scoreForSort(b) - scoreForSort(a))
      .slice(0, 3);
    const s6 = await kvSET(`vb:day:${ymd}:combined`, JSON.stringify(merged), diag);

    return res.status(200).json({
      ok: true,
      ymd,
      mutated: true,
      counts: { union: withPicks.length, last: withPicks.length, combined: withPicks.length },
      source: src,
      saved_backends: Array.from(new Set([...(s1||[]), ...(s2||[]), ...(s3||[]), ...(s4||[]), ...(s5||[]), ...(s6||[])])),
      ...(wantDebug ? { debug: { slot, odds_called: called, odds_filled: filled, kept: withPicks.length, returned: shortList.length } } : {})
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
