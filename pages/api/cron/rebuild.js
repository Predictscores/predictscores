// FILE: pages/api/cron/rebuild.js
export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";
const FEATURE_HISTORY = process.env.FEATURE_HISTORY === "1";

// Budžeti po slotu
const SLOT_WEEKDAY_LIMIT      = parseInt(process.env.SLOT_WEEKDAY_LIMIT      || "15", 10);
const SLOT_WEEKEND_LIMIT      = parseInt(process.env.SLOT_WEEKEND_LIMIT      || "25", 10);
const SLOT_LATE_WEEKDAY_LIMIT = parseInt(process.env.SLOT_LATE_WEEKDAY_LIMIT || "3",  10);
const SLOT_LATE_WEEKEND_LIMIT = parseInt(process.env.SLOT_LATE_WEEKEND_LIMIT || "5",  10);

// Cap-ovi
const LEAGUE_CAP_PER_SLOT = parseInt(process.env.VB_MAX_PER_LEAGUE || "2", 10);
const UEFA_DAILY_CAP      = parseInt(process.env.UEFA_DAILY_CAP    || "6", 10);

/* ---------------- time helpers ---------------- */
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
  const dt = new Date(String(iso||"").replace(" ","T"));
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

/* ---------------- KV helpers ---------------- */
async function kvGET(key){
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return (js && typeof js==="object" && "result" in js) ? js.result : js;
}
async function kvSET(key, value){
  return fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  }).then(r=>r.ok);
}
async function kvDEL(key){
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  }).catch(()=>{});
}

/* ---------------- utils ---------------- */
function parseArray(raw){
  try{
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object"){
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v){
        const inner=v.value;
        if (typeof inner==="string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}

function isUEFA(name=""){
  const s = String(name).toLowerCase();
  return /uefa|champions|europa|conference|euro qualifiers|euro cup/.test(s);
}

function groupOf(p){
  const league = String(p?.league?.name || "");
  if (isUEFA(league)) return "UEFA";
  return "DOM";
}

function dedupeUnion(...lists){
  const seen = new Set();
  const out = [];
  for (const arr of lists){
    for (const it of (arr||[])){
      const k = `${it?.fixture_id||""}|${String(it?.market||"")}|${String(it?.selection||"")}`;
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/* --- slot window: LATE 00:00–10:00, AM 10:00–15:00, PM 15:00–24:00 --- */
function inSlotWindow(pick, dayCET, slot){
  const iso = pick?.datetime_local?.starting_at?.date_time
           || pick?.datetime_local?.date_time
           || pick?.time?.starting_at?.date_time
           || null;
  if (!iso) return false;
  const tz = toTZParts(iso, TZ);
  if (tz.ymd !== dayCET) return false;

  if (slot === "am")   return tz.hour >= 10 && tz.hour < 15;
  if (slot === "pm")   return tz.hour >= 15 && tz.hour < 24;
  if (slot === "late") return tz.hour >= 0  && tz.hour < 10;
  return true;
}

/* ---------------- HISTORY capture record ---------------- */
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

/* ---------------- handler ---------------- */
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
      if (h < 10) slot = "late";
      else if (h < 15) slot = "am";
      else slot = "pm";
    }

    // generator kandidata (interni endpoint)
    const r = await fetch(`${base}/api/value-bets`, { headers: { "cache-control":"no-store" } });
    if (!r.ok) return res.status(200).json({ ok:false, error:`generator ${r.status}` });
    const j = await r.json().catch(()=>null);
    const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];

    // filtriraj po slot prozoru
    const dayArr = arr.filter(pick => inSlotWindow(pick, dayCET, slot));

    // slot budžet
    const isWE = isWeekendInTZ(now, TZ);
    const slotLimit = (slot==="late")
      ? (isWE ? SLOT_LATE_WEEKEND_LIMIT : SLOT_LATE_WEEKDAY_LIMIT)
      : (isWE ? SLOT_WEEKEND_LIMIT : SLOT_WEEKDAY_LIMIT);

    // trenutni UEFA usage preko svih slotova za taj dan
    const am  = parseArray(await kvGET(`vb:day:${dayCET}:am`));
    const pm  = parseArray(await kvGET(`vb:day:${dayCET}:pm`));
    const lt  = parseArray(await kvGET(`vb:day:${dayCET}:late`));
    const unionExisting = dedupeUnion(am, pm, lt);
    const uefaUsed = unionExisting.filter(p => isUEFA(p?.league?.name)).length;
    let uefaLeft = Math.max(0, UEFA_DAILY_CAP - uefaUsed);

    // sort bazni: confidence desc, ev desc, kickoff asc
    dayArr.sort((a,b)=>{
      const ca = Number(a?.confidence_pct || 0), cb = Number(b?.confidence_pct || 0);
      if (cb!==ca) return cb - ca;
      const ea = Number.isFinite(a?.ev) ? a.ev : -Infinity;
      const eb = Number.isFinite(b?.ev) ? b.ev : -Infinity;
      if (eb!==ea) return eb - ea;
      const ta = new Date(String(a?.datetime_local?.starting_at?.date_time||"").replace(" ","T")).getTime();
      const tb = new Date(String(b?.datetime_local?.starting_at?.date_time||"").replace(" ","T")).getTime();
      return ta - tb;
    });

    // bucketizacija po grupama (UEFA/DOM) i izbor uz limite
    const buckets = new Map();
    for (const p of dayArr){
      const g = groupOf(p);
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(p);
    }
    const idx = Object.fromEntries(Array.from(buckets.keys()).map(k=>[k,0]));
    const takenByLeague = new Map();
    const picked = [];

    while (picked.length < slotLimit){
      let took = 0;
      for (const [g, list] of buckets.entries()){
        let i = idx[g] || 0;
        for (; i < list.length; i++){
          const pick = list[i];
          const leagueName = pick?.league?.name || "";
          const isUefa = isUEFA(leagueName);
          if (isUefa) {
            if (uefaLeft <= 0) continue;
            picked.push(pick);
            uefaLeft--;
            took++;
            break;
          } else {
            const lkey = `${pick?.league?.id||""}`;
            const cnt = takenByLeague.get(lkey) || 0;
            if (cnt >= LEAGUE_CAP_PER_SLOT) continue;
            takenByLeague.set(lkey, cnt+1);
            picked.push(pick);
            took++;
            break;
          }
        }
        idx[g] = i;
      }
      if (!took) break;
    }

    // upis slota
    const slotKey = `vb:day:${dayCET}:${slot}`;
    await kvSET(slotKey, picked);

    // UNION (AM∪PM∪LATE) → pišemo u :union (apply-learning posle puni :last)
    const union = dedupeUnion(
      parseArray(await kvGET(`vb:day:${dayCET}:am`)),
      parseArray(await kvGET(`vb:day:${dayCET}:pm`)),
      parseArray(await kvGET(`vb:day:${dayCET}:late`))
    );
    await kvSET(`vb:day:${dayCET}:union`, union);

    // marker za rebuild (bez :last!)
    await kvSET(`vb:jobs:last:rebuild`, { ts: Date.now(), slot });

    // HISTORY capture (Top-3 za AM/PM, Top-1 za LATE)
    if (FEATURE_HISTORY) {
      const histKey = `hist:${dayCET}:${slot}`;
      const existing = parseArray(await kvGET(histKey));
      if (!existing || existing.length === 0) {
        const topN = (slot === "late") ? 1 : 3;
        const top = picked.slice(0, topN).map(pick => toHistoryRecord(slot, pick));
        if (top.length) {
          await kvSET(histKey, top);
          const idxKey = `hist:index`;
          let days = parseArray(await kvGET(idxKey));
          if (!Array.isArray(days)) days = [];
          if (!days.includes(dayCET)) days.push(dayCET);
          days.sort().reverse();
          const keep = days.slice(0, 14);
          await kvSET(idxKey, keep);
          for (const d of days.slice(14)) {
            await kvDEL(`hist:${d}:am`);
            await kvDEL(`hist:${d}:pm`);
            await kvDEL(`hist:${d}:late`);
          }
        }
      }
    }

    return res.status(200).json({
      ok: true,
      snapshot_for: dayCET,
      slot,
      count_slot: picked.length,
      count_union: union.length,
      persisted: true
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message || e) });
  }
    }
