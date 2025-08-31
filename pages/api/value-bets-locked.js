// pages/api/value-bets-locked.js
// KV-only fetch za UI (Combined/Football/History).
// Combined: vrati TAČNO 3 najviša "confidence" predloga preko svih marketa,
// ali bez menjanja fronta: koristimo polje `items`.
// - Kao bazu koristimo 1X2 iz vbl/vbl_full (football).
// - Ako vbl_full sadrži `extras_by_fixture` (BTTS/OU2.5/HT-FT), po svakoj utakmici biramo
//   najkonfidentniji pick među {1X2, extras...}, pa globalno uzmemo TOP-3 i stavimo u `items`.
// - `football` ostaje cela 1X2 lista (25), da Football tab radi isto kao i do sada.

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function ymdInTZ(d = new Date(), tz = TZ) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    return fmt.format(d);
  } catch {
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0"), dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}
function slotOfHour(h) { return h < 10 ? "late" : (h < 15 ? "am" : "pm"); }
function localHour(tz = TZ) {
  try { return Number(new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date())); }
  catch { return new Date().getUTCHours(); }
}

async function kvGETraw(key){
  const base = process.env.KV_REST_API_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return null;
  const r = await fetch(`${base.replace(/\/+$/, "")}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(()=>null);
  if (!r || !r.ok) return null;
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json().catch(()=>null) : await r.text().catch(()=>null);
  return (body && typeof body==="object" && "result" in body) ? body.result : body;
}

function toObj(v){
  try { return typeof v==="string" ? JSON.parse(v) : v; } catch { return null; }
}
function arrFromAny(o){
  if (!o || typeof o!=="object") return [];
  return Array.isArray(o.items) ? o.items :
         Array.isArray(o.value_bets) ? o.value_bets :
         Array.isArray(o.football) ? o.football :
         Array.isArray(o.arr) ? o.arr :
         Array.isArray(o.data) ? o.data : [];
}

export default async function handler(req, res){
  try {
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    const slot = (req.query.slot && String(req.query.slot)) || slotOfHour(localHour(TZ));
    const nMax = Math.max(1, Math.min( Number(req.query.n || 3), 50 ));

    // 1) probaj prvo "full" zbog extras_by_fixture
    const keys = [
      `vbl_full:${ymd}:${slot}`,
      `vbl:${ymd}:${slot}`,
      `vb-locked:${ymd}:${slot}`,
      `vb:locked:${ymd}:${slot}`,
      `vb_locked:${ymd}:${slot}`,
      `locked:vbl:${ymd}:${slot}`
    ];
    let gotFull=null, gotSlim=null, picked=null;
    for (const k of keys) {
      const raw = await kvGETraw(k);
      if (!raw) continue;
      const obj = toObj(raw);
      if (!obj) continue;
      if (!picked) picked=k;
      if (!gotFull && /vbl_full:/.test(k)) gotFull=obj;
      if (!gotSlim && /^(vbl:|vb-locked:|vb:locked:|vb_locked:|locked:vbl:)/.test(k)) gotSlim=obj;
      if (gotFull && gotSlim) break;
    }

    const fullArr = arrFromAny(gotFull);
    const slimArr = arrFromAny(gotSlim) || fullArr;
    const football = slimArr; // 1X2 lista koja puni Football tab

    // Ako nemamo ništa, vrati prazno kao i ranije
    if (!Array.isArray(football) || football.length === 0) {
      return res.status(200).json({
        ok:true, slot, ymd, items:[], value_bets:[], football:[], source:"vb-locked:kv:miss·robust"
      });
    }

    // 2) Combined: TOP-3 po confidence preko svih marketa, po jednoj utakmici
    // Najpre skupimo najbolje po utakmici: among {1X2, extras...} uzmi onaj sa max confidence_pct
    const extras = gotFull && typeof gotFull==="object" ? gotFull.extras_by_fixture || {} : {};

    const byFixtureBest = [];
    const idxByFixture = new Map();
    for (const r of football) {
      if (!r || !r.fixture_id) continue;
      const fid = r.fixture_id;

      // kandidati za ovaj fixture: bazni 1X2 + extras (ako ih ima)
      const cands = [r];
      if (Array.isArray(extras[fid])) cands.push(...extras[fid]);

      // izaberi onaj sa najvećim confidence_pct
      let best = null;
      for (const c of cands) {
        if (!c || !Number.isFinite(c.confidence_pct)) continue;
        if (!best || c.confidence_pct > best.confidence_pct) best = c;
      }
      if (best) {
        byFixtureBest.push(best);
        idxByFixture.set(fid, best);
      }
    }

    // globalno sortiraj po confidence i uzmi top nMax (default 3)
    const combined = byFixtureBest
      .sort((a,b)=> (b.confidence_pct - a.confidence_pct) || (Number(b._ev||-9) - Number(a._ev||-9)))
      .slice(0, nMax);

    // 3) Response: items = combined(3), football = cela 1X2 lista (25)
    return res.status(200).json({
      ok:true, slot, ymd,
      items: combined,
      value_bets: combined,
      football,
      source: gotFull ? `vb-locked:kv:hit·full` : `vb-locked:kv:hit`,
    });

  } catch (e) {
    return res.status(200).json({ ok:true, slot: (req.query.slot||""), ymd: ymdInTZ(new Date(), TZ), items:[], value_bets:[], football:[], source:`vb-locked:error ${String(e?.message||e)}` });
  }
}
