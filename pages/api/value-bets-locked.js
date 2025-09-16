// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* ---------- TZ helpers ---------- */
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

/* ---------- KV (Vercel KV / Upstash REST) ---------- */
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
      const j = await r.json().catch(()=>null); // Upstash/Vercel REST shape: { result | value }
      const v = (j && ("result" in j ? j.result : j.value)) ?? null;
      if (v==null) continue;
      trace.push({ get:key, ok:true, flavor:b.flavor, hit:true });
      return v; // može biti string (JSON), ili već objekat
    } catch {}
  }
  trace.push({ get:key, ok:true, hit:false });
  return null;
}

/* ---------- Safe deserialization (bezbedna) ---------- */
function kvToItems(doc) {
  // 1) null/undefined
  if (doc == null) return { items: [] };

  let v = doc;

  // 2) Ako je ceo dokument STRING -> pokušaj JSON.parse
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return { items: [] }; }
  }

  // 3) Ako je { value: "<json-string>" } (REST) -> parse value
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return { items: [] }; }
  }

  // 4) Ako je rezultat direktno niz -> standardizuj
  if (Array.isArray(v)) return { items: v };

  // 5) Ako već ima items niz -> OK
  if (v && Array.isArray(v.items)) return v;

  // 6) Bilo šta drugo -> prazan standardni oblik
  return { items: [] };
}

/* ---------- VB params ---------- */
const VB_LIMIT = Number(process.env.VB_LIMIT || 25);
const VB_MAX_PER_LEAGUE = Number(process.env.VB_MAX_PER_LEAGUE || 2);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.5);
const MAX_ODDS = Number(process.env.MAX_ODDS || 5.5); // opciono: čuva kvalitet selekcija

/* ---------- Builders ---------- */
function toCandidateFromMarkets(fix){
  const out = [];
  const { markets = {} } = fix || {};

  // 1) BTTS Yes
  if (markets.btts?.yes && markets.btts.yes >= MIN_ODDS && markets.btts.yes <= MAX_ODDS) {
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
  if (markets.ou25?.over && markets.ou25.over >= MIN_ODDS && markets.ou25.over <= MAX_ODDS) {
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
  if (markets.fh_ou15?.over && markets.fh_ou15.over >= MIN_ODDS && markets.fh_ou15.over <= MAX_ODDS) {
    out.push({
      fixture_id: fix.fixture_id || fix.fixture?.id,
      market: "FH_OU1.5",
      pick: "Over 1.5 FH",
      pick_code: "FH O1.5",
      selection_label: "FH Over 1.5",
      odds: { price: Number(markets.fh_ou15.over) },
    });
  }
  // 4) HT/FT — uzmi razumnije prvo (HH, DD, AA ...)
  const htft = fix.markets?.htft || {};
  const HTFT_ORDER = ["hh","dd","aa","hd","dh","ha","ah","da","ad"];
  for (const code of HTFT_ORDER) {
    const price = Number(htft[code]);
    if (Number.isFinite(price) && price >= MIN_ODDS && price <= Math.max(MAX_ODDS, 10)) {
      out.push({
        fixture_id: fix.fixture_id || fix.fixture?.id,
        market: "HTFT",
        pick: code.toUpperCase(),
        pick_code: `HTFT:${code.toUpperCase()}`,
        selection_label: `HT/FT ${code.toUpperCase()}`,
        odds: { price },
      });
      if (out.length >= 4) break; // ne gomilati previše iz jedne utakmice
    }
  }

  // meta
  for (const c of out) {
    c.league = fix.league;
    c.league_name = fix.league?.name;
    c.league_country = fix.league?.country;
    c.teams = fix.teams;
    c.home = fix.home;
    c.away = fix.away;
    c.kickoff = fix.kickoff;
    c.kickoff_utc = fix.kickoff_utc || fix.kickoff;
    c.model_prob = null;
    c.confidence_pct = 60; // neutralno dok ne dodamo model
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

    // 1) Učitaj KV i bezbedno deserializuj
    let union = await kvGET(unionKey, trace);
    let full  = await kvGET(fullKey,  trace);
    union = kvToItems(union);
    full  = kvToItems(full);

    // 2) Odaberi bazu (preferiraj full jer ima markets)
    const base = full.items.length ? full.items : union.items;

    if (!base.length){
      return res.status(200).json({
        ok:true, ymd, slot, source:null,
        items:[], tickets:{ btts:[], ou25:[], htft:[], fh_ou15:[] },
        debug:{ trace }
      });
    }

    // 3) Generiši kandidate iz markets
    const expanded = [];
    for (const f of base) {
      const adds = toCandidateFromMarkets(f);
      if (adds.length) expanded.push(...adds);
    }

    // 4) Guard: minimalna kompletiranost (≥2 tržišta po meču) – za kvalitet
    const byFixture = new Map();
    for (const c of expanded) {
      const fid = c.fixture_id;
      const arr = byFixture.get(fid) || [];
      arr.push(c.market);
      byFixture.set(fid, arr);
    }
    const goodFixture = new Set(
      [...byFixture.entries()].filter(([_, arr]) => new Set(arr).size >= 2).map(([fid]) => fid)
    );
    const filtered = expanded.filter(c => goodFixture.has(c.fixture_id));

    // 5) Cap po ligi i globalni limit
    const capped = capPerLeague(filtered);

    // 6) Grupacija u tikete
    const tickets = groupTickets(capped);

    // 7) Odgovor
    return res.status(200).json({
      ok:true, ymd, slot,
      source: full.items.length ? "vbl_full" : "vb:day",
      items: capped,
      tickets,
      debug: { trace }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
