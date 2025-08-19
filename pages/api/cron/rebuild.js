// pages/api/cron/rebuild.js
// Slotovani snapshoti (AM/PM/LATE) sa per-slot budžetima i tier-miks selekcijom.
// UEFA dnevni cap (preko svih slotova). UNION (AM∪PM∪LATE) upis u :last.
// Idempotent guard: 60s. + HISTORY: snimi Top3/Top1 po slotu (ako FEATURE_HISTORY=1).

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const FEATURE_HISTORY = process.env.FEATURE_HISTORY === "1";

// Budžeti po slotu
const SLOT_WEEKDAY_LIMIT = parseInt(process.env.SLOT_WEEKDAY_LIMIT || "15", 10);
const SLOT_WEEKEND_LIMIT = parseInt(process.env.SLOT_WEEKEND_LIMIT || "25", 10);
const SLOT_LATE_WEEKDAY_LIMIT = parseInt(process.env.SLOT_LATE_WEEKDAY_LIMIT || "3", 10);
const SLOT_LATE_WEEKEND_LIMIT = parseInt(process.env.SLOT_LATE_WEEKEND_LIMIT || "5", 10);

// Cap-ovi
const LEAGUE_CAP_PER_SLOT = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const UEFA_DAILY_CAP = parseInt(process.env.UEFA_DAILY_CAP || "6", 10);

function ymdInTZ(d=new Date(), tz=TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
    return fmt.format(d);
  } catch {
    const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,"0"), dd=String(d.getUTCDate()).padStart(2,"0");
    return `${y}-${m}-${dd}`;
  }
}
function hourInTZ(d=new Date(), tz=TZ){
  try {
    const fmt = new Intl.DateTimeFormat("en-CA",{ timeZone: tz, hour:"2-digit", hour12:false });
    return parseInt(fmt.format(d),10);
  } catch { return d.getHours(); }
}
function toTZParts(iso, tz=TZ){
  const dt = new Date(iso);
  return { ymd: ymdInTZ(dt, tz), hour: hourInTZ(dt, tz) };
}
function isWeekendInTZ(d=new Date(), tz=TZ){
  try{
    const wd = new Intl.DateTimeFormat("en-US",{ timeZone: tz, weekday: "short" }).format(d);
    return wd === "Sat" || wd === "Sun";
  }catch{
    const day = d.getUTCDay(); // 0=Sun,6=Sat
    return day === 0 || day === 6;
  }
}

// KV helpers
async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function kvSET(key, value){
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  let js=null; try{ js=await r.json(); }catch{}
  return { ok:r.ok, js };
}
async function kvDEL(key){
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  }).catch(()=>{});
}
function parseArray(raw){
  try{ let v=raw; if (typeof v==="string") v=JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v==="object"){
      if (Array.isArray(v.value_bets)) return v.value_bets;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v){ const inner=v.value;
        if (typeof inner==="string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}
function dedupeUnion(...lists){
  const map = new Map();
  for (const L of lists){
    for (const p of (L||[])){
      const id = p?.fixture_id ?? `${p?.league?.id||""}-${p?.teams?.home?.name||""}-${p?.teams?.away?.name||""}`;
      if (!map.has(id)) map.set(id, p);
    }
  }
  return Array.from(map.values());
}

// Tier grupisanje
function groupOf(leagueNameRaw){
  const name = String(leagueNameRaw||"").toLowerCase();
  if (/uefa|champions league|europa league|conference league|super cup/.test(name)) return "UEFA";
  if (/premier league|la liga|serie a|bundesliga|ligue 1|eredivisie|primeira liga|liga portugal|süper lig|super lig|pro league|first division a|jupiler|premiership|super league|austria bundesliga|brasileirao|serie a brasil|mls|ligue 1 uber eats/.test(name)) return "TIER1";
  if (/championship|segunda|serie b|2\.?bundesliga|ligue 2|eerste divisie|challenge|portugal 2|segunda liga|scottish championship|ekstraklasa|first league|allsvenskan|eliteserien|superliga/.test(name)) return "TIER2";
  return "TIER3";
}

// Slot window
function inSlotWindow(pick, dayCET, slot){
  const t = String(p?.datetime_local?.starting_at?.date_time || "").replace(" ","T");
  const tz = toTZParts(t, TZ);
  if (tz.ymd !== dayCET) return false;
  if (slot === "am")   return tz.hour >= 10 && tz.hour < 15;
  if (slot === "pm")   return tz.hour >= 15 && tz.hour < 24;
  if (slot === "late") return tz.hour >= 0  && tz.hour <  3;
  return true;
}

// HISTORY helper
function toHistoryRecord(slot, pick){
  return {
    fixture_id: pick?.fixture_id,
    teams: { home: pick?.teams?.home?.name, away: pick?.teams?.away?.name },
    league: { id: pick?.league?.id, name: pick?.league?.name, country: pick?.league?.country },
    kickoff: String(pick?.datetime_local?.starting_at?.date_time || "").replace(" ","T"),
    slot: String(slot || "").toUpperCase(),
    market: pick?.market,
    selection: pick?.selection,
    odds: Number(pick?.market_odds),
    locked_at: new Date().toISOString(),
    final_score: null,
    won: null,
    settled_at: null
  };
}

export default async function handler(req, res){
  try {
    // cooldown 60s
    const lastRunRaw = await kvGET(`vb:jobs:last:rebuild`);
    const nowMs = Date.now();
    try {
      const last = (typeof lastRunRaw==="string") ? JSON.parse(lastRunRaw) : lastRunRaw;
      if (last && nowMs - Number(last?.ts||0) < 60_000) {
        return res.status(200).json({ ok:true, skipped:true, reason:"cooldown", at:new Date().toISOString() });
      }
    } catch {}

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const base  = `${proto}://${host}`;

    // slot
    const slotQ = String(req.query.slot||"").toLowerCase();
    const now = new Date();
    const dayCET = ymdInTZ(now, TZ);
    let slot = slotQ;
    if (!slot) {
      const h = hourInTZ(now, TZ);
      if (h < 15) slot = "am";
      else if (h < 24) slot = "pm";
      else slot = "late";
    }

    // generator kandidata
    const r = await fetch(`${base}/api/value-bets`, { headers: { "cache-control":"no-store" } });
    if (!r.ok) return res.status(200).json({ ok:false, error:`generator ${r.status}` });
    const j = await r.json().catch(()=>null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    // filtriraj po slot prozoru
    const dayArr = arr.filter(p => inSlotWindow(p, dayCET, slot));

    // slot budžet (radni/ vikend)
    const isWE = isWeekendInTZ(now, TZ);
    const slotLimit = (slot==="late")
      ? (isWE ? SLOT_LATE_WEEKEND_LIMIT : SLOT_LATE_WEEKDAY_LIMIT)
      : (isWE ? SLOT_WEEKEND_LIMIT : SLOT_WEEKDAY_LIMIT);

    // pročitaj već postojeće slotove za UEFA dnevni cap
    const alreadyAM   = parseArray(await kvGET(`vb:day:${dayCET}:am`));
    const alreadyPM   = parseArray(await kvGET(`vb:day:${dayCET}:pm`));
    const alreadyLATE = parseArray(await kvGET(`vb:day:${dayCET}:late`));
    const uefaUsed = [...alreadyAM, ...alreadyPM, ...alreadyLATE].filter(p => groupOf(p?.league?.name)==="UEFA").length;
    const uefaLeft = Math.max(0, UEFA_DAILY_CAP - uefaUsed);

    // rangiraj pre miksa
    dayArr.sort((a,b)=>{
      if ((b?.confidence_pct||0)!==(a?.confidence_pct||0)) return (b.confidence_pct||0)-(a.confidence_pct||0);
      const eva = Number.isFinite(a?.ev) ? a.ev : -Infinity;
      const evb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
      if (evb!==eva) return evb-eva;
      const ta=+new Date(String(a?.datetime_local?.starting_at?.date_time||"").replace(" ","T"));
      const tb=+new Date(String(b?.datetime_local?.starting_at?.date_time||"").replace(" ","T"));
      return ta-tb;
    });

    // pripremi buckets
    const buckets = { UEFA:[], TIER1:[], TIER2:[], TIER3:[] };
    for (const p of dayArr){
      const g = groupOf(p?.league?.name);
      (buckets[g] || buckets.TIER3).push(p);
    }
    const order = ["UEFA","TIER1","TIER2","TIER3"];
    const idx = { UEFA:0, TIER1:0, TIER2:0, TIER3:0 };

    // league-cap per slot (osim za UEFA)
    const takenByLeague = new Map();
    let uefaTakenThisSlot = 0;

    const picked = [];
    while (picked.length < slotLimit) {
      let took = 0;
      for (const g of order){
        if (picked.length >= slotLimit) break;
        const arrG = buckets[g]; if (!arrG || idx[g] >= arrG.length) continue;

        // pronađi sledećeg koji prolazi cap-ove
        let i = idx[g];
        while (i < arrG.length) {
          const pick = arrG[i++];
          if (g === "UEFA") {
            if (uefaLeft <= 0) break; // više nema dnevnog prostora za UEFA
            // UEFA ne ograničavamo league-cap-om
            picked.push(pick);
            uefaTakenThisSlot++;
            took++;
            break;
          } else {
            const lkey = `${pick?.league?.id||""}`;
            const cnt = takenByLeague.get(lkey) || 0;
            if (cnt >= LEAGUE_CAP_PER_SLOT) continue; // probaj sledećeg u grupi
            takenByLeague.set(lkey, cnt+1);
            picked.push(pick);
            took++;
            break;
          }
        }
        idx[g] = i;
      }
      if (!took) break; // nema više kandidata u krugu
    }

    // ako je UEFA cap ostao, a ima UEFA kandidata i prostora u slotu, popuni još malo
    if (picked.length < slotLimit && uefaLeft > 0 && uefaTakenThisSlot < uefaLeft) {
      while (picked.length < slotLimit && idx.UEFA < (buckets.UEFA?.length||0) && (uefaTakenThisSlot < uefaLeft)) {
        picked.push(buckets.UEFA[idx.UEFA++]);
        uefaTakenThisSlot++;
      }
    }

    // upis slota
    const slotKey = `vb:day:${dayCET}:${slot}`;
    await kvSET(slotKey, picked);

    // UNION (AM∪PM∪LATE) -> :last
    const union = dedupeUnion(
      parseArray(await kvGET(`vb:day:${dayCET}:am`)),
      parseArray(await kvGET(`vb:day:${dayCET}:pm`)),
      parseArray(await kvGET(`vb:day:${dayCET}:late`))
    );
    const rev = Math.floor(nowMs/1000);
    await kvSET(`vb:day:${dayCET}:rev:${rev}`, union);
    await kvSET(`vb:day:${dayCET}:last`, union);
    await kvSET(`vb:day:${ymdInTZ(now, "UTC")}:last`, union);
    await kvSET(`vb:jobs:last:rebuild`, { ts: nowMs, slot });

    // ---------------- HISTORY: upiši Top3/Top1 po slotu (jednokratno) ----------------
    if (FEATURE_HISTORY) {
      const histKey = `hist:${dayCET}:${slot}`;
      const existing = parseArray(await kvGET(histKey));
      if (!existing || existing.length === 0) {
        const topN = (slot === "late") ? 1 : 3;
        const top = picked.slice(0, topN).map(p => toHistoryRecord(slot, p));
        if (top.length) {
          await kvSET(histKey, top);
          // indeks dana i trim >14d
          const idxKey = `hist:index`;
          let days = parseArray(await kvGET(idxKey));
          if (!Array.isArray(days)) days = [];
          if (!days.includes(dayCET)) days.push(dayCET);
          // sort DESC i trim na 14
          days.sort().reverse();
          const keep = days.slice(0, 14);
          await kvSET(idxKey, keep);
          // obriši starije ključeve
          for (const d of days.slice(14)) {
            await kvDEL(`hist:${d}:am`);
            await kvDEL(`hist:${d}:pm`);
            await kvDEL(`hist:${d}:late`);
          }
        }
      }
    }
    // -------------------------------------------------------------------------------

    return res.status(200).json({
      ok: true,
      snapshot_for: dayCET,
      slot,
      count_slot: picked.length,
      count_union: union.length,
      uefa_used_before: uefaUsed,
      uefa_added_this_slot: uefaTakenThisSlot,
      rev,
      persisted: true
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
