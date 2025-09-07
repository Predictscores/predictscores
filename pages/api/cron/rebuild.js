// pages/api/cron/rebuild.js
// Rekonstrukcija "locked" feed-a za dati slot.
// Ako kandidati u KV nemaju kickoff (npr. vbl:* lista ID-jeva), povuci detalje iz API-Football,
// izračunaj slot (late 00–09, am 10–14, pm 15–23), filtriraj i upiši u vb:day:<YMD>:<slot> (+union, +last).

export const config = { api: { bodyParser: false } };

const TZ = "Europe/Belgrade";

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
        headers: { Authorization: `Bearer ${c.token}` },
        cache: "no-store",
      });
      const ok = r.ok;
      const j  = ok ? await r.json().catch(() => null) : null;
      const raw = j && typeof j.result === "string" ? j.result : null;
      diag && (diag.reads = diag.reads || [], diag.reads.push({ flavor:c.flavor, key, status: ok ? (raw ? "hit" : "miss-null") : `http-${r.status}` }));
      if (raw) return { raw, flavor: c.flavor };
    } catch (e) {
      diag && (diag.reads = diag.reads || [], diag.reads.push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` }));
    }
  }
  return { raw: null, flavor: null };
}
async function kvSET(key, valueString, diag) {
  let saved = [];
  for (const c of kvCfgs().filter(x => x.flavor.endsWith(":rw"))) {
    try {
      const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ value: valueString }),
      });
      if (r.ok) saved.push(c.flavor);
      diag && (diag.writes = diag.writes || [], diag.writes.push({ flavor:c.flavor, key, status:r.ok ? "ok" : `http-${r.status}` }));
    } catch (e) {
      diag && (diag.writes = diag.writes || [], diag.writes.push({ flavor:c.flavor, key, status:`err:${String(e?.message||e)}` }));
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

// ROBUSNO: timestamp > kickoff_utc > datetime_local > fixture.date...
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
  if (!d) return false;  // STROGO: bez vremena -> ne prolazi slot
  const h = hourInTZ(d, TZ);
  if (slot === "late") return h < 10;            // 00–09
  if (slot === "am")   return h >= 10 && h < 15; // 10–14
  return h >= 15;                                 // 15–23
}

/* ---------------- API-Football (fixtures) ---------------- */
const AF_BASE = "https://v3.football.api-sports.io";
function afKey(){ return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || ""; }
async function afFetch(path, params={}){
  const key = afKey();
  if (!key) throw new Error("Missing API-Football key");
  const url = new URL(`${AF_BASE}${path}`);
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
    // minimalni stubovi za UI
    market: "1X2",
    selection_label: null,
    pick: null,
    pick_code: null,
    model_prob: null,
    confidence_pct: null,
    odds: null,
    fixture: { id, timestamp: ts, date: kick }, // čuvamo i raw za buduće
  };
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
    // 1) Učitaj kandidate iz KV (pokušaj redom)
    const prefer = [
      `vb:day:${ymd}:${slot}`,   // već gotovi
      `vb:day:${ymd}:union`,
      `vb:day:${ymd}:last`,
      `vbl_full:${ymd}:${slot}`, // meta sa vremenima
      `vbl:${ymd}:${slot}`,      // često samo ID-jevi
    ];
    let rawArr = null, src = null;
    for (const k of prefer) {
      const { raw } = await kvGET(k, diag);
      const arr = arrFromAny(unpack(raw));
      if (arr && arr.length) { rawArr = arr; src = k; break; }
    }

    // 2) Ako je `vbl:*` (verovatno lista ID-jeva) – povuci detalje iz AF da bismo imali kickoff
    let items = null;
    if (rawArr && rawArr.length) {
      const looksLikeIdsOnly = rawArr.every(v =>
        typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ||
        (v && typeof v === "object" && v.fixture_id == null && v.fixture?.id == null && v.kickoff_utc == null)
      );

      if (looksLikeIdsOnly) {
        const ids = Array.from(new Set(rawArr.map(v => Number(v)).filter(n => Number.isFinite(n)))).slice(0, 60);
        const lanes = 6;
        const buckets = Array.from({ length: lanes }, () => []);
        ids.forEach((x,i)=> buckets[i%lanes].push(x));

        const got = [];
        const lane = async (subset) => {
          for (const id of subset) {
            try {
              const jf = await afFetch("/fixtures", { id });
              const fx = Array.isArray(jf?.response) ? jf.response[0] : null;
              if (fx) got.push(mapFixtureToItem(fx));
            } catch {}
            await new Promise(r=>setTimeout(r, 120));
          }
        };
        await Promise.all(buckets.map(lane));
        items = got;
        src = `${src}→af:fixtures[id]`;
      } else {
        // već su objekti sa metama
        items = rawArr;
      }
    }

    // 3) Ako i dalje nemamo ništa → fallback: povuci sve mečeve za datum pa filtriraj
    if (!items || !items.length) {
      const jf = await afFetch("/fixtures", { date: ymd, timezone: TZ });
      const resp = Array.isArray(jf?.response) ? jf.response : [];
      items = resp.map(mapFixtureToItem);
      src = "fallback:af-fixtures";
    }

    // 4) Slot-filter (STROG: bez kickoffa → out)
    const before = items.length;
    const filtered = items
      .filter(x => inSlotLocal(x, slot))
      .sort((a,b)=> (Date.parse(a.kickoff_utc||0) - Date.parse(b.kickoff_utc||0)))
      .slice(0, 60);
    const after = filtered.length;

    // 5) Upis u vb:day:* (kompatibilni box format)
    const boxed = JSON.stringify({ value: JSON.stringify(filtered) });
    const kSlot   = `vb:day:${ymd}:${slot}`;
    const kUnion  = `vb:day:${ymd}:union`;
    const kLast   = `vb:day:${ymd}:last`;
    const s1 = await kvSET(kSlot,  boxed, diag);
    const s2 = await kvSET(kUnion, boxed, diag);
    const s3 = await kvSET(kLast,  boxed, diag);

    return res.status(200).json({
      ok: true,
      ymd,
      mutated: true,
      counts: { union: after, last: after, combined: after },
      source: src,
      saved_backends: Array.from(new Set([...(s1||[]), ...(s2||[]), ...(s3||[])])),
      ...(wantDebug ? { debug: { before, after, slot } } : {})
    });

  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
