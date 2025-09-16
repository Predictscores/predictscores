// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ ---------- */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function pickSlotAuto(now) {
  const h = hourInTZ(now, TZ);
  return (h<10) ? "late" : (h<15) ? "am" : "pm";
}

/* ---------- KV ---------- */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGET(key, trace=[]) {
  for (const b of kvBackends()) {
    try {
      const u = `${b.url}/get/${encodeURIComponent(key)}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const v = j?.result ?? j?.value ?? null;
      if (v==null) continue;
      const out = typeof v==="string" ? JSON.parse(v) : v;
      trace.push({get:key, ok:true, flavor:b.flavor, hit:true});
      return out;
    } catch {}
  }
  trace.push({get:key, ok:true, hit:false});
  return null;
}

/* ---------- Build helpers ---------- */
const VB_LIMIT = Number(process.env.VB_LIMIT || 25);
const VB_MAX_PER_LEAGUE = Number(process.env.VB_MAX_PER_LEAGUE || 2);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);

function toCandidateFromMarkets(fix){
  const out = [];
  const { markets = {} } = fix || {};

  // 1) BTTS Yes
  if (markets.btts?.yes && markets.btts.yes >= MIN_ODDS) {
    out.push({
      fixture_id: fix.fixture_id || fix.fixture?.id,
      market: "BTTS",
      pick: "Yes",
      pick_code: "BTTS:Y",
      selection_label: "BTTS Yes",
      odds: { price: Number(markets.btts.yes) },
    });
  }
  // 2) OU 2.5 Over
  if (markets.ou25?.over && markets.ou25.over >= MIN_ODDS) {
    out.push({
      fixture_id: fix.fixture_id || fix.fixture?.id,
      market: "OU2.5",
      pick: "Over 2.5",
      pick_code: "O2.5",
      selection_label: "Over 2.5",
      odds: { price: Number(markets.ou25.over) },
    });
  }
  // 3) FH OU 1.5 Over
  if (markets.fh_ou15?.over && markets.fh_ou15.over >= MIN_ODDS) {
    out.push({
      fixture_id: fix.fixture_id || fix.fixture?.id,
      market: "FH_OU1.5",
      pick: "Over 1.5 FH",
      pick_code: "FH O1.5",
      selection_label: "FH Over 1.5",
      odds: { price: Number(markets.fh_ou15.over) },
    });
  }
  // 4) HT/FT — uzmi 2-3 najrazumnija (HH, DD, AA) ako postoje
  const htft = fix.markets?.htft || {};
  const HTFT_ORDER = ["hh","dd","aa","hd","dh","ha","ah","da","ad"];
  for (const code of HTFT_ORDER) {
    const price = Number(htft[code]);
    if (Number.isFinite(price) && price >= MIN_ODDS) {
      out.push({
        fixture_id: fix.fixture_id || fix.fixture?.id,
        market: "HTFT",
        pick: code.toUpperCase(),
        pick_code: `HTFT:${code.toUpperCase()}`,
        selection_label: `HT/FT ${code.toUpperCase()}`,
        odds: { price },
      });
      // ne gomilati previše iz jedne utakmice
      if (out.length >= 4) break;
    }
  }

  // dodaj zajedničke meta podatke
  for (const c of out) {
    c.league = fix.league;
    c.league_name = fix.league?.name;
    c.league_country = fix.league?.country;
    c.teams = fix.teams;
    c.home = fix.home;
    c.away = fix.away;
    c.kickoff = fix.kickoff;
    c.kickoff_utc = fix.kickoff_utc || fix.kickoff;
    // "confidence" = neutralno 60 dok ne ukrstimo sa modelom
    c.model_prob = null;
    c.confidence_pct = 60;
  }
  return out;
}

function capPerLeague(items){
  const per = new Map();
  const out = [];
  for (const it of items){
    const key = String(it?.league?.id || it?.league_name || "?");
    const cur = per.get(key) || 0;
    if (cur >= VB_MAX_PER_LEAGUE) continue;
    per.set(key, cur+1);
    out.push(it);
    if (out.length >= VB_LIMIT) break;
  }
  return out;
}

function groupTickets(items){
  const t = { btts: [], ou25: [], fh_ou15: [], htft: [] };
  for (const it of items){
    if (it.market === "BTTS") t.btts.push(it);
    else if (it.market === "OU2.5") t.ou25.push(it);
    else if (it.market === "FH_OU1.5") t.fh_ou15.push(it);
    else if (it.market === "HTFT") t.htft.push(it);
  }
  // ograniči 3–5 po tiketu
  const clamp = arr => arr.slice(0, Math.max(3, Math.min(5, arr.length)));
  t.btts   = clamp(t.btts);
  t.ou25   = clamp(t.ou25);
  t.fh_ou15= clamp(t.fh_ou15);
  t.htft   = clamp(t.htft);
  return t;
}

/* ---------- main ---------- */
export default async function handler(req, res){
  const trace = [];
  try{
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);
    let slot = String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot = pickSlotAuto(now);

    const unionKey = `vb:day:${ymd}:${slot}`;
    const fullKey  = `vbl_full:${ymd}:${slot}`;
    const ticketsKey = `tickets:${ymd}:${slot}`;

    const union = await kvGET(unionKey, trace);
    const full  = await kvGET(fullKey,  trace);

    const base = Array.isArray(full?.items) && full.items.length ? full.items
               : Array.isArray(union?.items) ? union.items : [];

    if (!base.length){
      return res.status(200).json({ ok:true, ymd, slot, source:null, items:[], tickets:{ btts:[], ou25:[], htft:[], fh_ou15:[] }, debug:{ trace } });
    }

    // kandidati iz markets
    const expanded = [];
    for (const f of base) {
      const adds = toCandidateFromMarkets(f);
      if (adds.length) expanded.push(...adds);
    }

    // cap po ligi i globalni limit
    const capped = capPerLeague(expanded);

    // grupiši u 4 tiketa
    const tickets = groupTickets(capped);

    return res.status(200).json({
      ok:true, ymd, slot,
      source: "vbl_full",
      items: capped,
      tickets,
      debug: { trace }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
