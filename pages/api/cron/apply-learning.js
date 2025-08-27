// FILE: pages/api/cron/apply-learning.js
// Ne diramo learning logiku (pretpostavlja se da je već nameštena van ovog fajla).
// Ovaj job čita slot picks, sortira/boostuje (ako postoje weights) i:
// 1) upisuje u :last (što koristi Combined/Football UI),
// 2) upisuje u HISTORY tačno Top 3 iz Combined po slotu,
// 3) održava indeks poslednjih 14 dana.

export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

// History uključivanje preko ENV (ostavi kako već koristiš)
const FEATURE_HISTORY = process.env.FEATURE_HISTORY === "1";

// VAŽNO: po default-u čuvamo baš ono što je u Combined → Top 3
// (možeš promeniti ENV-om ako zatreba: npr. HISTORY_STORE_TOP_N=5)
const HIST_TOP_N = Number(process.env.HISTORY_STORE_TOP_N || 3);

/* ---------- KV helpers ---------- */
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.result ?? null;
}
async function kvSet(key, val) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type":"application/json" },
    body: JSON.stringify({ value: val }),
  }).catch(()=>{});
}
async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  }).catch(()=>{});
}

/* ---------- time helpers ---------- */
function str(x){ return (typeof x === "string" ? x : x==null ? "" : String(x)); }
function ymdInTZ(d = new Date(), tz = TZ) {
  const s = d.toLocaleString("en-CA", { timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" });
  return (s.split(",")[0] || s);
}
function hhInTZ(d = new Date(), tz = TZ){
  const s = d.toLocaleString("en-GB", { timeZone: tz, hour:"2-digit", minute:"2-digit", hour12:false });
  const [h] = String(s).split(":");
  return Number(h);
}
function toTZParts(iso, tz = TZ){
  const dt = new Date(String(iso||"").replace(" ","T"));
  const y = ymdInTZ(dt, tz);
  const h = hhInTZ(dt, tz);
  return { ymd: y, hour: h };
}
function inSlotWindow(pick, ymd, slot){
  const iso = pick?.datetime_local?.starting_at?.date_time
           || pick?.datetime_local?.date_time
           || pick?.time?.starting_at?.date_time
           || pick?.kickoff
           || null;
  if (!iso) return false;
  const tz = toTZParts(iso, TZ);
  if (tz.ymd !== ymd) return false;
  if (slot === "am")   return tz.hour >= 10 && tz.hour < 15;
  if (slot === "pm")   return tz.hour >= 15 && tz.hour < 24;
  if (slot === "late") return tz.hour >= 0  && tz.hour < 10;
  return true;
}

/* ---------- learning weights primena (ostavljeno netaknuto) ---------- */
function applyWeights(items, weights) {
  if (!Array.isArray(items)) return [];
  if (!weights) return items;
  return items.map((p) => {
    let adj = 0;
    const mk = p?.market_label || p?.market || "";
    if (weights?.markets && typeof weights.markets[mk] === "number") adj += weights.markets[mk];
    if (typeof weights?.global === "number") adj += weights.global;
    const base = p?.confidence_pct ?? p?.confidence ?? 0;
    const conf = Math.max(0, Math.min(100, base + adj));
    return { ...p, confidence_pct: conf };
  });
}

/* ---------- HISTORY: zapis sa ispravnim teams objektom ---------- */
function toHistoryRecord(slot, pick){
  const homeName = str(pick?.teams?.home?.name) || str(pick?.home) || str(pick?.home_name);
  const awayName = str(pick?.teams?.away?.name) || str(pick?.away) || str(pick?.away_name);
  return {
    fixture_id: pick?.fixture_id ?? pick?.id ?? null,
    teams: {
      home: { id: pick?.teams?.home?.id ?? pick?.home_id ?? null, name: homeName || null },
      away: { id: pick?.teams?.away?.id ?? pick?.away_id ?? null, name: awayName || null },
    },
    // dodatni fallback da UI i stari zapisi rade
    home_name: homeName || null,
    away_name: awayName || null,
    league: {
      id: pick?.league?.id ?? null,
      name: pick?.league?.name ?? pick?.league_name ?? null,
      country: pick?.league?.country ?? pick?.country ?? null
    },
    kickoff: String(pick?.datetime_local?.starting_at?.date_time || pick?.kickoff || "").replace(" ","T"),
    slot: String(slot || "").toUpperCase(),
    market: pick?.market || pick?.market_label || null,
    selection: pick?.selection || null,
    odds: Number(pick?.market_odds) || Number(pick?.odds) || null,
    locked_at: new Date().toISOString(),

    // ostavi mesta da postojeći cron-ovi za settle upišu ishod
    final_score: pick?.final_score ?? null,
    won: pick?.won ?? null,
    settled_at: pick?.settled_at ?? null,
  };
}

export default async function handler(req, res){
  try{
    const now  = new Date();
    const ymd  = ymdInTZ(now);
    const hour = hhInTZ(now);
    const slot = hour < 10 ? "late" : hour < 15 ? "am" : "pm";

    // ČITAMO kandidovane predloge za aktivni slot (seed koji već koristiš u projektu)
    const slotKey = `vb:day:${ymd}:${slot}`;
    const rawItems = (await kvGet(slotKey)) || [];

    // filtriraj u slot prozor (sigurnosno)
    const slotItems = Array.isArray(rawItems) ? rawItems.filter(p => inSlotWindow(p, ymd, slot)) : [];

    // Learning weights (NE menjamo ih; samo primenjujemo ako postoje)
    const weights = await kvGet(`vb:learn:weights`);

    // Boost + sort by confidence
    const boosted = applyWeights(slotItems, weights)
      .slice()
      .sort((a,b) => (Number(b?.confidence_pct || 0) - Number(a?.confidence_pct || 0)));

    // PIŠI :last + :last_meta (ovo koristi Combined/Football UI)
    await kvSet(`vb:day:${ymd}:last`, boosted);
    await kvSet(`vb:meta:${ymd}:last_meta`, {
      ymd, slot, built_at: new Date().toISOString(), count: boosted.length, source: `slot:${slot}`,
    });

    // HISTORY: tačno ono što vidiš u Combined → Top 3 po slotu (kroz HIST_TOP_N)
    if (FEATURE_HISTORY) {
      const N = Number.isFinite(HIST_TOP_N) ? HIST_TOP_N : 3;
      const toStore = boosted.slice(0, Math.max(0, N)).map(p => toHistoryRecord(slot, p));

      const histKey = `hist:${ymd}:${slot}`;
      await kvSet(histKey, toStore);

      // indeks poslednjih 14 dana
      const idxKey = `hist:index`;
      let days = await kvGet(idxKey);
      try { days = Array.isArray(days) ? days : JSON.parse(days); } catch {}
      if (!Array.isArray(days)) days = [];
      if (!days.includes(ymd)) days.push(ymd);
      days.sort().reverse();
      const keep = days.slice(0, 14);
      await kvSet(idxKey, keep);

      // trim viškove dana
      for (const d of days.slice(14)) {
        await kvDel(`hist:${d}:am`);
        await kvDel(`hist:${d}:pm`);
        await kvDel(`hist:${d}:late`);
      }
    }

    res.status(200).json({ ok:true, ymd, slot, count: boosted.length });
  } catch (e) {
    res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
