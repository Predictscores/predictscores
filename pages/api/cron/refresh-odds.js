// pages/api/cron/refresh-odds.js

export const config = { api: { bodyParser: false } };

/* =========================
   Opšta podešavanja
========================= */
const TZ = (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) || "Europe/Belgrade";

/* =========================
   KV HELPERS (Vercel KV / Upstash)
========================= */
function kvCfgs() {
  const list = [];
  const url = (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
  const rw  = (process.env.KV_REST_API_TOKEN || "").trim();
  const ro  = (process.env.KV_REST_API_READ_ONLY_TOKEN || "").trim();
  if (url && rw) list.push({ flavor: "vercel-kv:rw", url, token: rw });
  if (url && ro) list.push({ flavor: "vercel-kv:ro", url, token: ro });
  // Back-compat: Upstash (ako postoji)
  const uurl = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const utok = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  if (uurl && utok) list.push({ flavor: "upstash:rw", url: uurl, token: utok });
  return list;
}
async function kvGET(key, diag) {
  for (const c of kvCfgs()) {
    try {
      const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${c.token}` }, cache: "no-store",
      });
      const j = r.ok ? await r.json().catch(()=>null) : null;
      const raw = (typeof j?.result === "string") ? j.result : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:r.ok ? (raw?"hit":"miss") : `http-${r.status}` });
      if (raw) return { raw, flavor:c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, valueString, diag) {
  const saved = [];
  for (const c of kvCfgs().filter(x => x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization:`Bearer ${c.token}`, "Content-Type":"application/json" },
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

/* --- ATOMSKI INCR/DECR (kvota za TheOddsAPI) --- */
async function kvINCR_ATOMIC(key, by = 1, diag) {
  // Prefer /incr endpoint (Vercel KV / Upstash)
  for (const c of kvCfgs().filter(x => x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/incr/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization:`Bearer ${c.token}`, "Content-Type":"application/json" },
        cache: "no-store",
        body: JSON.stringify({ amount: by })
      });
      const j = r.ok ? await r.json().catch(()=>null) : null;
      const v = Number(j?.result);
      if (Number.isFinite(v)) { diag && (diag.incr = diag.incr||[]).push({flavor:c.flavor,key,v}); return v; }
    } catch {}
  }
  // Fallback (ne-atomski)
  const cur = Number(JSON.parse((await kvGET(key, diag)).raw || "0")) || 0;
  const next = cur + by;
  await kvSET(key, JSON.stringify(next), diag);
  return next;
}
async function kvDECR_ATOMIC(key, by = 1, diag) {
  return kvINCR_ATOMIC(key, -Math.abs(by), diag);
}

/* =========================
   Pomoćne funkcije
========================= */
const J = s => { try { return JSON.parse(String(s||"")); } catch { return null; } };

function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x==="object"){
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value==="string"){ const v=J(x.value); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
    if (Array.isArray(x.list))  return x.list;
  }
  if (typeof x==="string"){ const v=J(x); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
  return null;
}
function unpack(raw){
  if (!raw || typeof raw!=="string") return null;
  let v = J(raw);
  if (Array.isArray(v)) return v;
  if (v && typeof v==="object" && "value" in v){
    if (Array.isArray(v.value)) return v.value;
    if (typeof v.value === "string"){ const v2 = J(v.value); if (Array.isArray(v2)) return v2; if (v2 && typeof v2==="object") return arrFromAny(v2); }
    return null;
  }
  if (v && typeof v==="object") return arrFromAny(v);
  return null;
}

/* --- vreme/slot --- */
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
function slotForKickoffISO(iso){
  const h = new Date(iso).toLocaleString("en-GB",{ hour:"2-digit", hour12:false, timeZone:TZ });
  return deriveSlot(parseInt(h,10));
}

/* --- filter lige: ignoriši youth & sl. --- */
function isYouthOrBanned(item){
  const ln  = (item?.league_name || item?.league?.name || "").toString();
  const tnH = (item?.home || item?.teams?.home?.name || "").toString();
  const tnA = (item?.away || item?.teams?.away?.name || "").toString();
  const s = `${ln} ${tnH} ${tnA}`;
  return /\bU(-|\s)?(17|18|19|20|21|22|23)\b/i.test(s) || /\bPrimavera\b/i.test(s) || /\bYouth\b/i.test(s);
}

/* =========================
   API-Football (fixtures/odds)
========================= */
const AF_BASE = (process.env.API_FOOTBALL_BASE_URL || "https://v3.football.api-sports.io").replace(/\/+$/,"");
const AF_KEY  = (process.env.API_FOOTBALL_KEY || "").trim();
const afHeaders = () => ({ "x-apisports-key": AF_KEY });

async function afFetch(path, params={}, diagTag, diag){
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers: afHeaders(), cache:"no-store" });
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  if (diag) (diag.af = diag.af || []).push({ host:AF_BASE, tag:diagTag, path, params, status:r.status, ok:r.ok, results:j?.results, errors:j?.errors });
  return j || {};
}
function mapFixture(fx){
  const id = Number(fx?.fixture?.id);
  const ts = Number(fx?.fixture?.timestamp||0)*1000 || Date.parse(fx?.fixture?.date||0) || 0;
  const kick = new Date(ts).toISOString();
  return {
    fixture_id: id,
    league_name: fx?.league?.name,
    league_country: fx?.league?.country,
    teams: { home: fx?.teams?.home?.name, away: fx?.teams?.away?.name },
    home: fx?.teams?.home?.name, away: fx?.teams?.away?.name,
    kickoff_utc: kick,
  };
}
async function fetchFixturesIDsByDateStrict(ymd, slot, diag){
  const variants = [
    { tag:"date+tz", params:{ date: ymd, timezone: TZ } },
    { tag:"date",    params:{ date: ymd } },
    { tag:"from-to", params:{ from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants){
    const j0 = await afFetch("/fixtures",{...v.params},`fixtures:${v.tag}:p0`,diag);
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    const tot = Number(j0?.paging?.total||1);
    for(let page=2; page<=Math.min(tot,12); page++){
      const j = await afFetch("/fixtures",{...v.params,page},`fixtures:${v.tag}:p${page}`,diag);
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}
async function refreshAfOddsByFixtureIds(ids, diag){
  let touched = 0;
  for (const id of ids){
    try{
      const jo = await afFetch("/odds",{ fixture:id }, "odds", diag);
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:Boolean(jo?.response?.length) });
      touched++;
    }catch(e){
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:false, err:String(e?.message||e) });
    }
  }
  return touched;
}

/* =========================
   TheOddsAPI (BTTS / OU2.5 / HTFT)
========================= */
const OA_BASE    = (process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4").replace(/\/+$/,"");
const OA_KEY     = (process.env.ODDS_API_KEY || "").trim();
const OA_REGION  = (process.env.ODDS_API_REGION || process.env.ODDS_API_REGIONS || "eu").trim(); // npr. "eu"
const OA_MARKETS = (process.env.ODDS_API_MARKETS || "h2h,totals,btts,ht_ft").trim();
// TVRDI LIMIT — default 15 (možeš override env-om ODDS_API_DAILY_CAP, ali ćemo zadržati max 15)
const OA_DAILY_CAP = Math.min(15, Math.max(1, Number(process.env.ODDS_API_DAILY_CAP || 15) || 15));

function oaUrl() {
  const u = new URL(`${OA_BASE}/sports/soccer/odds`);
  u.searchParams.set("apiKey", OA_KEY);
  u.searchParams.set("regions", OA_REGION);
  u.searchParams.set("markets", OA_MARKETS);
  u.searchParams.set("oddsFormat", "decimal");
  u.searchParams.set("dateFormat", "iso");
  return u.toString();
}

function normalizeTeamName(s=""){ return s.replace(/\s+FC\b/i,"").trim(); }

function buildTicketsFromOA(oaEvents = []) {
  const btts = [];
  const ou25 = [];
  const htft = [];

  for (const ev of oaEvents) {
    const home = normalizeTeamName(ev?.home_team || "");
    const away = normalizeTeamName(ev?.away_team || "");
    const kickoff = ev?.commence_time ? new Date(ev.commence_time).toISOString() : null;

    const markets = Array.isArray(ev?.bookmakers?.[0]?.markets) ? ev.bookmakers[0].markets : (Array.isArray(ev?.markets) ? ev.markets : []);
    if (!markets || !markets.length) continue;

    const mByKey = new Map();
    for (const m of markets) mByKey.set(String(m?.key || m?.market || "").toLowerCase(), m);

    // BTTS
    const mBtts = mByKey.get("btts") || mByKey.get("both_teams_to_score") || null;
    if (mBtts && Array.isArray(mBtts.outcomes)) {
      const yes = mBtts.outcomes.find(o => /yes/i.test(o.name||""));
      if (yes && yes.price) {
        btts.push({
          market: "BTTS",
          market_label: "Both Teams To Score",
          selection: "Yes",
          market_odds: Number(yes.price),
          implied_prob: 1 / Number(yes.price),
          home, away,
          kickoff_utc: kickoff,
        });
      }
    }

    // OU 2.5 (totals)
    const mTotals = mByKey.get("totals") || mByKey.get("total") || null;
    if (mTotals && Array.isArray(mTotals.outcomes)) {
      // tražimo liniju 2.5 (možda je u outcomes sa point=2.5 ili name 'Over 2.5')
      const over25 = mTotals.outcomes.find(o =>
        /over/i.test(o.name||"") && (String(o.point||"") === "2.5" || /2\.5/.test(String(o.name||"")))
      );
      if (over25 && over25.price) {
        ou25.push({
          market: "OU2.5",
          market_label: "Over/Under 2.5",
          selection: "Over",
          line: 2.5,
          market_odds: Number(over25.price),
          implied_prob: 1 / Number(over25.price),
          home, away,
          kickoff_utc: kickoff,
        });
      }
    }

    // HT/FT
    const mHtft = mByKey.get("ht_ft") || mByKey.get("half_time_full_time") || null;
    if (mHtft && Array.isArray(mHtft.outcomes)) {
      // prioritet H/H pa A/A, onda ostalo
      const pick = mHtft.outcomes.find(o => /home\/home|h\/h/i.test(o.name||"")) ||
                   mHtft.outcomes.find(o => /away\/away|a\/a/i.test(o.name||"")) ||
                   mHtft.outcomes[0];
      if (pick && pick.price) {
        htft.push({
          market: "HTFT",
          market_label: "Half Time / Full Time",
          selection: pick.name,
          market_odds: Number(pick.price),
          implied_prob: 1 / Number(pick.price),
          home, away,
          kickoff_utc: kickoff,
        });
      }
    }
  }

  // Jednostavan cut — ne ograničavamo ovde; UI/reader filtrira po vremenu.
  return { btts, ou25, htft };
}

/* --- jedan “batched” TheOddsAPI poziv sa TVRDIM dnevnim limitom --- */
async function tryTheOddsBatchAndSave(ymd, slot, diag) {
  const summary = { matched:0, saved:0, calls:0, budget_per_day: OA_DAILY_CAP, remaining_before:0, used_now:0, saved_btts:0, saved_ou25:0, saved_htft:0 };

  if (!OA_KEY) return summary; // nema ključa – nema poziva

  const capKey = `oa:cap:${ymd}`; // dnevni brojač
  // ATOMSKA REZERVACIJA PRE poziva
  const reserved = await kvINCR_ATOMIC(capKey, 1, diag);
  if (reserved > OA_DAILY_CAP) {
    // vratiti rezervaciju i preskočiti
    await kvDECR_ATOMIC(capKey, 1, diag);
    summary.remaining_before = Math.max(0, OA_DAILY_CAP - (reserved - 1));
    return summary;
  }
  summary.used_now = 1;
  summary.calls = 1;
  summary.remaining_before = Math.max(0, OA_DAILY_CAP - (reserved - 1));

  // Izvrši 1 poziv
  const url = oaUrl();
  const r = await fetch(url, { cache: "no-store" });
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  diag && (diag.odds_api = diag.odds_api || []).push({ host:OA_BASE, path:"/sports/soccer/odds", region:OA_REGION, market:OA_MARKETS, status:r.status, ok:r.ok, count:Array.isArray(j)?j.length:0, remaining: Number(r.headers.get("x-requests-remaining")||""), raw_status: j?.message||"" });

  if (!r.ok || !Array.isArray(j)) {
    // poziv je potrošen u svakom slučaju; ne vraćamo rezervaciju (jer provider je evidentirao call)
    return summary;
  }

  const tickets = buildTicketsFromOA(j);
  // upiši u KV per-slot ključ
  const key = `tickets:${ymd}:${slot}`;
  const payload = {
    btts: tickets.btts,
    ou25: tickets.ou25,
    htft: tickets.htft
  };
  await kvSET(key, JSON.stringify(payload), diag);
  summary.saved_btts = tickets.btts.length;
  summary.saved_ou25 = tickets.ou25.length;
  summary.saved_htft = tickets.htft.length;
  summary.saved = summary.saved_btts + summary.saved_ou25 + summary.saved_htft;

  return summary;
}

/* =========================
   Glavni handler
========================= */
export default async function handler(req, res) {
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const wantDebug = String(q.debug ?? "") === "1";
  const diag = wantDebug ? {} : null;

  try {
    // vreme/slot
    const now = new Date();
    const ymd  = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));

    // Lista ID-jeva (iz feeda), pa fallback na fixtures by date
    const tried = [];
    let pickedKey = null;
    let list = [];

    async function takeFromKey(key, picker){
      tried.push(key);
      const { raw } = await kvGET(key, diag);
      const arr = arrFromAny(unpack(raw));
      if (!Array.isArray(arr) || arr.length===0) return false;
      const ids = (picker ? arr.map(picker) : arr).map(x=>Number(x)).filter(Boolean);
      if (!ids.length) return false;
      if (list.length===0){ list = Array.from(new Set(ids)); pickedKey = key; }
      return true;
    }

    await takeFromKey(`vb:day:${ymd}:${slot}`, x=>x?.fixture_id);
    if (list.length===0) await takeFromKey(`vb:day:${ymd}:union`, x=>x?.fixture_id);
    if (list.length===0) await takeFromKey(`vb:day:${ymd}:last`,  x=>x?.fixture_id);
    if (list.length===0) await takeFromKey(`vbl_full:${ymd}:${slot}`);
    if (list.length===0) {
      // seed preko API-Football
      const ids = await fetchFixturesIDsByDateStrict(ymd, slot, diag);
      list = ids;
      if (ids.length) {
        await kvSET(`fixtures:${ymd}:${slot}`, JSON.stringify(ids), diag);
        await kvSET(`fixtures:multi`, JSON.stringify(ids), diag);
      }
    }

    const ids = Array.from(new Set(list));
    const touched = ids.length ? await refreshAfOddsByFixtureIds(ids, diag) : 0;

    // TheOddsAPI tickets (sa TVRDIM limitom 15/dan)
    const oa_summary = await tryTheOddsBatchAndSave(ymd, slot, diag);

    return res.status(200).json({
      ok:true, ymd, slot,
      inspected: ids.length, filtered:0, targeted: ids.length, touched,
      source: pickedKey ? `refresh-odds:${pickedKey}` : "refresh-odds:seeded-or-empty",
      debug: wantDebug ? {
        tried, pickedKey, listLen: ids.length, af: diag?.af, odds: diag?.odds,
        odds_api: diag?.odds_api, incr: diag?.incr, oa_summary
      } : undefined
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
