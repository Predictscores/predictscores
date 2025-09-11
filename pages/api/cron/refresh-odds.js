// pages/api/cron/refresh-odds.js

export const config = { api: { bodyParser: false } };

const TZ = (process.env.TZ_DISPLAY && process.env.TZ_DISPLAY.trim()) || "Europe/Belgrade";

/* ---------- KV helpers ---------- */
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
        headers: { Authorization: `Bearer ${c.token}` },
        cache: "no-store",
      });
      const j = r.ok ? await r.json().catch(()=>null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status: r.ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` });
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || []).push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` });
    }
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, valueString, diag) {
  const saved = [];
  for (const c of kvCfgs().filter(x=>x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type":"application/json" },
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
const J = s => { try { return JSON.parse(String(s||"")); } catch { return null; } };
function arrFromAny(x){
  if (!x) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "object") {
    if (Array.isArray(x.value)) return x.value;
    if (typeof x.value === "string") { const v = J(x.value); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
    if (Array.isArray(x.items)) return x.items;
    if (Array.isArray(x.data))  return x.data;
  }
  if (typeof x === "string") { const v = J(x); if (Array.isArray(v)) return v; if (v && typeof v==="object") return arrFromAny(v); }
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

/* ---------- time/slot ---------- */
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
function isYouthOrBanned(item){
  const ln = (item?.league_name || item?.league?.name || "").toString();
  const tnH = (item?.home || item?.teams?.home?.name || "").toString();
  const tnA = (item?.away || item?.teams?.away?.name || "").toString();
  const s = `${ln} ${tnH} ${tnA}`;
  return /\bU(-|\s)?(17|18|19|20|21|22|23)\b/i.test(s) || /\bPrimavera\b/i.test(s) || /\bYouth\b/i.test(s);
}

/* ---------- API-Football ---------- */
const AF_BASE = "https://v3.football.api-sports.io";
const afFixturesHeaders = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim() });
const afOddsHeaders     = () => ({ "x-apisports-key": (process.env.API_FOOTBALL_KEY || "").trim() });

async function afFetch(path, params={}, headers=afFixturesHeaders(), diagTag, diag){
  const url = new URL(`${AF_BASE}${path}`);
  Object.entries(params).forEach(([k,v])=> (v!=null) && url.searchParams.set(k,String(v)));
  const r = await fetch(url, { headers, cache:"no-store" });
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  if (diag) (diag.af = diag.af || []).push({ host: AF_BASE, tag: diagTag, path, params, status: r.status, ok: r.ok, results: j?.results, errors: j?.errors });
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

/* ---------- fixtures (p0 bez page; paging samo ako treba) ---------- */
async function fetchFixturesIDsByDateStrict(ymd, slot, diag){
  const variants = [
    { tag:"date+tz", params:{ date: ymd, timezone: TZ } },
    { tag:"date",    params:{ date: ymd } },
    { tag:"from-to", params:{ from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants){
    const j0 = await afFetch("/fixtures",{...v.params},afFixturesHeaders(),`fixtures:${v.tag}:p0`,diag);
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    const tot = Number(j0?.paging?.total||1);
    for(let page=2; page<=Math.min(tot,12); page++){
      const j = await afFetch("/fixtures",{...v.params,page},afFixturesHeaders(),`fixtures:${v.tag}:p${page}`,diag);
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}
async function fetchFixturesIDsWholeDay(ymd, slot, diag){
  const variants = [
    { tag:"date+tz", params:{ date: ymd, timezone: TZ } },
    { tag:"date",    params:{ date: ymd } },
    { tag:"from-to", params:{ from: ymd, to: ymd } },
  ];
  const bag = new Map();
  for (const v of variants){
    const j0 = await afFetch("/fixtures",{...v.params},afFixturesHeaders(),`fixtures:${v.tag}:p0`,diag);
    const arr0 = Array.isArray(j0?.response) ? j0.response : [];
    for (const fx of arr0){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    const tot = Number(j0?.paging?.total||1);
    for(let page=2; page<=Math.min(tot,12); page++){
      const j = await afFetch("/fixtures",{...v.params,page},afFixturesHeaders(),`fixtures:${v.tag}:p${page}`,diag);
      const arr = Array.isArray(j?.response) ? j.response : [];
      for (const fx of arr){ const m=mapFixture(fx); if(!m.fixture_id) continue; if(isYouthOrBanned(m)) continue; if (slotForKickoffISO(m.kickoff_utc)!==slot) continue; bag.set(m.fixture_id,m); }
    }
    if (bag.size) break;
  }
  return Array.from(bag.keys());
}

/* ---------- ODDS_API (OU2.5 only, capped) ---------- */
const OA_BASE = (process.env.ODDS_API_BASE_URL || "https://api.the-odds-api.com/v4").replace(/\/+$/,"");
const OA_KEY  = (process.env.ODDS_API_KEY || "").trim();
const OA_REGION  = (process.env.ODDS_API_REGION || process.env.ODDS_API_REGIONS || "eu").trim();
const OA_DAILY_CAP = Math.max(1, Number(process.env.ODDS_API_DAILY_CAP || 15) || 15); // hard default 15

async function oaCallTotalsForFixtureIds(fixtureIds, diag){
  if (!OA_KEY || !fixtureIds?.length) return { ok:false, count:0, remaining:null, raw_status:"noop/no-key" };

  // Jedan poziv koji vraća više mečeva (ekonomično)
  const url = new URL(`${OA_BASE}/sports/soccer/odds`);
  url.searchParams.set("apiKey", OA_KEY);
  url.searchParams.set("regions", OA_REGION);
  url.searchParams.set("markets", "h2h,totals");
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  // The Odds API nema univerzalni "fixture_id" iz AF; mapira event id-ove svoje. Zato ostajemo na širokom "soccer/odds" (1 call).
  // Filtriranje radimo posle, po protivnicima/vremenu ako je potrebno (ovde samo agregacija po mečevima koji stignu).

  const r = await fetch(url, { cache:"no-store" });
  const t = await r.text();
  let j=null; try { j = JSON.parse(t); } catch {}
  diag && (diag.odds_api = diag.odds_api || []).push({ host: OA_BASE, path:"/sports/soccer/odds", region:OA_REGION, market:"h2h,totals", status:r.status, ok:r.ok, count: Array.isArray(j)? j.length : 0, remaining: r.headers.get("x-requests-remaining") ?? null });

  if (!r.ok) return { ok:false, count:0, raw_status: t || String(r.status) };

  return { ok:true, data: Array.isArray(j)? j : [], raw_status:"ok" };
}

function bestOver25FromTotals(bookmakers){
  // Iz totals marketa biramo "Over" uz point ~ 2.5, uzimamo najbolju kvotu i broj kladionica
  let best = null; let books = 0;
  for (const b of bookmakers||[]){
    const m = (b.markets || []).find(x => (x.key || x.market || "").toLowerCase().includes("totals"));
    if (!m || !Array.isArray(m.outcomes)) continue;
    const over = (m.outcomes || []).find(o => String(o.name||o.outcome||"").toLowerCase()==="over" && (Math.abs(Number(o.point||2.5) - 2.5) <= 0.26));
    if (!over || !Number(over.price)) continue;
    books += 1;
    if (!best || Number(over.price) > Number(best.price)) best = { price:Number(over.price), point:Number(over.point||2.5) };
  }
  if (!best) return null;
  return { price: best.price, books_count: books };
}

/* ---------- tickets (merge save) ---------- */
async function mergeSaveTickets(ymd, slot, patch, diag){
  const keyDay  = `tickets:${ymd}`;
  const keySlot = `tickets:${ymd}:${slot}`;
  const curDay  = J((await kvGET(keyDay,  diag))?.raw)  || {};
  const curSlot = J((await kvGET(keySlot, diag))?.raw) || {};

  const nextDay  = { btts: curDay.btts||[],  ou25: curDay.ou25||[],  htft: curDay.htft||[]  };
  const nextSlot = { btts: curSlot.btts||[], ou25: curSlot.ou25||[], htft: curSlot.htft||[] };

  // samo OU2.5 patchevi trenutno
  if (Array.isArray(patch.ou25) && patch.ou25.length){
    nextDay.ou25  = patch.ou25;
    nextSlot.ou25 = patch.ou25;
  }

  await kvSET(keyDay,  JSON.stringify(nextDay),  diag);
  await kvSET(keySlot, JSON.stringify(nextSlot), diag);
}

/* ---------- odds refresh for AF & OA ---------- */
async function refreshOddsForIDs(ids, ymd, slot, diag){
  let touched = 0;

  // 1) API-Football odds (ne menjamo postojeće ponašanje)
  for (const id of ids){
    try{
      const jo = await afFetch("/odds", { fixture:id }, afOddsHeaders(), "odds", diag);
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:Boolean(jo?.response?.length) });
      touched++;
    }catch(e){
      diag && (diag.odds = diag.odds || []).push({ fixture:id, ok:false, err:String(e?.message||e) });
    }
  }

  // 2) The Odds API (OU2.5) — 1 poziv dnevno po slotu, cap 15 dnevno
  const budgetKey = `oa:budget:${ymd}`;
  const rawB = J((await kvGET(budgetKey, diag))?.raw) || { used:0 };
  const remaining_before = Math.max(0, OA_DAILY_CAP - Number(rawB.used||0));
  let used_now = 0, matched=0, saved_ou25=0;

  if (OA_KEY && remaining_before > 0){
    const r = await oaCallTotalsForFixtureIds(ids, diag);
    used_now = 1; // jedan poziv
    if (r.ok && Array.isArray(r.data)){
      // napravimo OU2.5 listu
      const picks = [];
      for (const ev of r.data){
        const commence = ev?.commence_time ? new Date(ev.commence_time).toISOString() : null;
        const slotGuess = commence ? slotForKickoffISO(commence) : slot; // fallback slot
        if (slotGuess !== slot) continue;

        const best = bestOver25FromTotals(ev.bookmakers);
        if (!best) continue;

        const price = Number(best.price);
        const implied = price>0 ? (1/price) : 0;
        const conf = Math.round(100*implied);

        // Formiramo minimalan pick kompatibilan sa UI-jem
        picks.push({
          fixture_id: Number(ev.id) || 0,
          league: { id: ev.league?.id, name: ev.sport_title || "Soccer", country: ev.country || null },
          league_name: ev.sport_title || "Soccer",
          league_country: ev.country || null,
          teams: { home: ev.home_team, away: ev.away_team },
          home: ev.home_team, away: ev.away_team,
          kickoff_utc: commence,
          selection_label: "Over/Under 2.5",
          market: "OU2.5",
          pick: "Over",
          pick_code: "ou_over25",
          implied_prob: implied,
          confidence_pct: conf,
          odds: { price, books_count: Number(best.books_count||0) },
        });
      }

      if (picks.length){
        matched = picks.length;
        saved_ou25 = picks.length;
        await mergeSaveTickets(ymd, slot, { ou25: picks }, diag);
      }
    }
    // upišemo budžet
    rawB.used = Math.min(OA_DAILY_CAP, Number(rawB.used||0) + used_now);
    await kvSET(budgetKey, JSON.stringify(rawB), diag);
  }

  return { touched, oa_summary: { matched, saved: saved_ou25, calls: used_now, budget_per_day: OA_DAILY_CAP, remaining_before, used_now } };
}

/* ---------- handler ---------- */
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  const q = req.query || {};
  const wantDebug = String(q.debug ?? "") === "1";
  const diag = wantDebug ? {} : null;

  try{
    const now = new Date();
    const ymd  = (q.ymd && /^\d{4}-\d{2}-\d{2}$/.test(String(q.ymd))) ? String(q.ymd) : ymdInTZ(now, TZ);
    const slot = (q.slot && /^(am|pm|late)$/.test(String(q.slot))) ? String(q.slot) : deriveSlot(hourInTZ(now, TZ));
    const forceSeed = String(q.force||"") === "1";

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
    if (list.length===0) await takeFromKey(`fixtures:multi`);

    if (list.length===0 || forceSeed){
      const strict = await fetchFixturesIDsByDateStrict(ymd, slot, diag);
      if (strict.length) list = strict;
      else {
        const whole = await fetchFixturesIDsWholeDay(ymd, slot, diag);
        if (whole.length) list = whole;
      }
      if (list.length){
        await kvSET(`fixtures:${ymd}:${slot}`, JSON.stringify(list), diag);
        await kvSET(`fixtures:multi`, JSON.stringify(list), diag);
      }
    }

    if (list.length===0){
      return res.status(200).json({
        ok:true, ymd, slot,
        inspected:0, filtered:0, targeted:0, touched:0,
        source:"refresh-odds:no-slot-matches",
        debug: wantDebug ? { tried, pickedKey, listLen:0, forceSeed:Boolean(forceSeed), af: diag?.af } : undefined
      });
    }

    const ids = Array.from(new Set(list));
    const { touched, oa_summary } = await refreshOddsForIDs(ids, ymd, slot, diag);

    return res.status(200).json({
      ok:true, ymd, slot,
      inspected: ids.length, filtered:0, targeted: ids.length, touched,
      source: pickedKey ? `refresh-odds:${pickedKey}` : "refresh-odds:fallback",
      debug: wantDebug ? { tried, pickedKey, listLen: ids.length, forceSeed:Boolean(forceSeed), af: diag?.af, odds: diag?.odds, odds_api: diag?.odds_api, oa_summary } : undefined
    });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
