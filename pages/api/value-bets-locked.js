// pages/api/value-bets-locked.js
export const config = { api: { bodyParser: false } };

/* =========================
 *  Inline helpers (KV)
 * ========================= */
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
      const v = (j && ("result" in j ? j.result : j.value)) ?? null;
      if (v==null) continue;
      trace.push({ get:key, ok:true, flavor:b.flavor, hit:true });
      return v;
    } catch {}
  }
  trace.push({ get:key, ok:true, hit:false });
  return null;
}
function kvToItems(doc) {
  if (doc == null) return { items: [] };
  let v = doc;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { return { items: [] }; } }
  if (v && typeof v === "object" && typeof v.value === "string") {
    try { v = JSON.parse(v.value); } catch { return { items: [] }; }
  }
  if (Array.isArray(v)) return { items: v };
  if (v && Array.isArray(v.items)) return v;
  return { items: [] };
}

/* =========================
 *  ENV / time helpers
 * ========================= */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function pickSlotAuto(now){ const h=hourInTZ(now, TZ); return h<10?"late":h<15?"am":"pm"; }

const VB_LIMIT = Number(process.env.VB_LIMIT || 25);
const VB_MAX_PER_LEAGUE = Number(process.env.VB_MAX_PER_LEAGUE || 2);
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.50);
const MAX_ODDS = Number(process.env.MAX_ODDS || 5.50);
const UEFA_DAILY_CAP = Number(process.env.UEFA_DAILY_CAP || 6);

const CAP_LATE = Number(process.env.CAP_LATE || 6);
const CAP_AM_WD = Number(process.env.CAP_AM_WD || 15);
const CAP_PM_WD = Number(process.env.CAP_PM_WD || 15);
const CAP_AM_WE = Number(process.env.CAP_AM_WE || 20);
const CAP_PM_WE = Number(process.env.CAP_PM_WE || 20);

function isWeekend(ymd){
  const [y,m,d]=ymd.split("-").map(Number);
  const dt=new Date(Date.UTC(y,m-1,d,12,0,0));
  const wd=new Intl.DateTimeFormat("en-GB",{ timeZone:TZ, weekday:"short"}).format(dt).toLowerCase();
  return wd==="sat"||wd==="sun";
}
function isUEFA(league){ const n=String(league?.name||"").toLowerCase(); return /uefa|champions|europa|conference|ucl|uel|uecl/.test(n); }

/* =========================
 *  Model helpers
 * ========================= */
function toProbability(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 1) {
    if (num <= 100) return Math.max(0, Math.min(1, num / 100));
    return null;
  }
  if (num < 0) return 0;
  return Math.max(0, Math.min(1, num));
}
function pluck(obj, path){
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}
function probabilityFromPaths(obj, paths){
  for (const path of paths) {
    const val = pluck(obj, path);
    const prob = toProbability(val);
    if (prob != null) return prob;
  }
  return null;
}
function probabilityValue(src, keys){
  if (!src || typeof src !== "object") return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      const prob = toProbability(src[key]);
      if (prob != null) return prob;
    }
  }
  return null;
}
function normalizedModelProbs(fix){
  const candidates = [fix?.model_probs, fix?.model?.probs, fix?.model?.probabilities, fix?.models?.probs, fix?.models?.probabilities];
  for (const src of candidates) {
    if (!src || typeof src !== "object") continue;
    const home = probabilityValue(src, ["home","Home","HOME","1","H","home_win","homeWin","p1","prob_home","prob1"]);
    const draw = probabilityValue(src, ["draw","Draw","DRAW","X","D","drawn","pX","prob_draw","probx"]);
    const away = probabilityValue(src, ["away","Away","AWAY","2","A","away_win","awayWin","p2","prob_away","prob2"]);
    if (home == null && draw == null && away == null) continue;
    const out = {};
    if (home != null) { out.home = home; out["1"] = home; }
    if (draw != null) { out.draw = draw; out["X"] = draw; }
    if (away != null) { out.away = away; out["2"] = away; }
    return out;
  }
  return null;
}
function buildModelContext(fix){
  return {
    oneXtwo: normalizedModelProbs(fix),
    btts: probabilityFromPaths(fix, [
      ["btts_probability"],
      ["model_probs","btts_yes"],
      ["model_probs","btts","yes"],
      ["model","btts_probability"],
      ["model","btts","yes"],
      ["models","btts","yes"],
    ]),
    ou25: probabilityFromPaths(fix, [
      ["over25_probability"],
      ["ou25_probability"],
      ["model_probs","over25"],
      ["model_probs","ou25_over"],
      ["model","over25_probability"],
      ["model","ou25","over"],
      ["models","ou25","over"],
    ]),
    fh_ou15: probabilityFromPaths(fix, [
      ["fh_over15_probability"],
      ["model_probs","fh_over15"],
      ["model_probs","fh_ou15_over"],
      ["model","fh_ou15","over"],
      ["models","fh_ou15","over"],
    ]),
  };
}
function impliedFromPrice(price){
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 1) return null;
  return 1 / p;
}
function normalizePickCode(rawCode, rawPick, rawLabel){
  const candidates = [rawCode, rawPick, rawLabel];
  for (const cand of candidates) {
    if (!cand) continue;
    const str = String(cand).trim();
    if (!str) continue;
    const up = str.toUpperCase();
    if (up.includes(":")) {
      const parts = up.split(":");
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    return up;
  }
  return "";
}
function modelProbabilityFor(ctx, marketRaw, pickCodeRaw, pickRaw, labelRaw){
  const market = String(marketRaw || "").toUpperCase();
  const code = normalizePickCode(pickCodeRaw, pickRaw, labelRaw);
  if (!code) return null;

  if (market === "BTTS") {
    const yes = ctx?.btts;
    if (yes == null) return null;
    if (code === "Y" || code === "YES") return yes;
    if (code === "N" || code === "NO") return 1 - yes;
    return null;
  }

  if (market === "OU2.5" || market === "O/U 2.5" || market === "OU25") {
    const over = ctx?.ou25;
    if (over == null) return null;
    if (code.startsWith("O")) return over;
    if (code.startsWith("U")) return 1 - over;
    return null;
  }

  if (market === "FH_OU1.5" || market === "FH OU1.5" || market === "FH-OU1.5") {
    const over = ctx?.fh_ou15;
    if (over == null) return null;
    if (code.includes("O")) return over;
    if (code.includes("U")) return 1 - over;
    return null;
  }

  if (market === "1X2" || market === "1X-2") {
    const map = ctx?.oneXtwo;
    if (!map) return null;
    if (code === "1" || code === "HOME") return map["1"] ?? map.home ?? null;
    if (code === "X" || code === "DRAW") return map["X"] ?? map.draw ?? null;
    if (code === "2" || code === "AWAY") return map["2"] ?? map.away ?? null;
    return null;
  }

  return null;
}
function confidenceFromModel(prob, implied){
  const hasProb = Number.isFinite(prob);
  const hasImplied = Number.isFinite(implied);
  if (!hasProb && !hasImplied) return 0;

  if (hasProb) {
    const p = Math.max(0, Math.min(1, prob));
    const base = p * 100;
    if (hasImplied) {
      const edge = (p - implied) * 100;
      const boosted = base + edge * 0.65;
      return Math.round(Math.max(20, Math.min(88, boosted)));
    }
    return Math.round(Math.max(20, Math.min(88, base)));
  }

  const ip = Math.max(0, Math.min(1, implied));
  return Math.round(Math.max(20, Math.min(88, ip * 100)));
}
function applyModelFields(candidate, ctx){
  const prob = modelProbabilityFor(ctx, candidate.market, candidate.pick_code, candidate.pick, candidate.selection_label);
  const implied = impliedFromPrice(candidate?.odds?.price);
  candidate.model_prob = prob != null ? prob : null;
  candidate.implied_prob = implied != null ? implied : null;
  if ((candidate.market || "").toUpperCase() === "1X2" && ctx?.oneXtwo) {
    candidate.model_probs = ctx.oneXtwo;
  }
  candidate.confidence_pct = confidenceFromModel(prob, implied);
  return candidate;
}
function oneXtwoCapForSlot(slot, we){ if(slot==="late") return CAP_LATE; if(!we) return slot==="am"?CAP_AM_WD:CAP_PM_WD; return slot==="am"?CAP_AM_WE:CAP_PM_WE; }

/* =========================
 *  Candidate builders
 * ========================= */
function fromMarkets(fix){
  const out=[]; const m=fix?.markets||{}; const fid=fix.fixture_id||fix.fixture?.id; const ctx = buildModelContext(fix);

  const push = (market, pick, pickCode, selectionLabel, rawPrice) => {
    const price = Number(rawPrice);
    if (!Number.isFinite(price)) return;
    const cand = {
      fixture_id: fid,
      market,
      pick,
      pick_code: pickCode,
      selection_label: selectionLabel,
      odds: { price },
    };
    applyModelFields(cand, ctx);
    out.push(cand);
  };

  if (Number.isFinite(m?.btts?.yes) && m.btts.yes>=MIN_ODDS && m.btts.yes<=MAX_ODDS) {
    push("BTTS", "Yes", "BTTS:Y", "BTTS Yes", m.btts.yes);
  }
  if (Number.isFinite(m?.ou25?.over) && m.ou25.over>=MIN_ODDS && m.ou25.over<=MAX_ODDS) {
    push("OU2.5", "Over 2.5", "O2.5", "Over 2.5", m.ou25.over);
  }
  if (Number.isFinite(m?.fh_ou15?.over) && m.fh_ou15.over>=MIN_ODDS && m.fh_ou15.over<=Math.max(MAX_ODDS,10)) {
    push("FH_OU1.5", "Over 1.5 FH", "FH O1.5", "FH Over 1.5", m.fh_ou15.over);
  }
  const htft=m.htft||{}; const ORDER=["hh","dd","aa","hd","dh","ha","ah","da","ad"];
  for (const code of ORDER){
    const price=Number(htft[code]);
    if (Number.isFinite(price) && price>=MIN_ODDS && price<=Math.max(MAX_ODDS,10)) {
      push("HTFT", code.toUpperCase(), `HTFT:${code.toUpperCase()}`, `HT/FT ${code.toUpperCase()}`, price);
      if (out.length>=6) break;
    }
  }

  for (const c of out) {
    c.league=fix.league; c.league_name=fix.league?.name; c.league_country=fix.league?.country;
    c.teams=fix.teams; c.home=fix.home; c.away=fix.away;
    c.kickoff=fix.kickoff; c.kickoff_utc=fix.kickoff_utc||fix.kickoff;
    if (typeof c.model_prob !== "number") c.model_prob = c.model_prob != null ? Number(c.model_prob) : null;
  }
  return out;
}
function oneXtwoOffers(fix){
  const xs=[]; const x=fix?.markets?.['1x2']||{}; const fid=fix.fixture_id||fix.fixture?.id; const ctx = buildModelContext(fix);
  const push=(code,label,price)=>{
    const p=Number(price);
    if(!Number.isFinite(p)||p<MIN_ODDS||p>MAX_ODDS) return;
    const cand={
      fixture_id:fid, market:"1x2", pick:code, pick_code:code, selection_label:label, odds:{price:p},
      league:fix.league, league_name:fix.league?.name,
      league_country:fix.league?.country, teams:fix.teams, home:fix.home, away:fix.away,
      kickoff:fix.kickoff, kickoff_utc:fix.kickoff_utc||fix.kickoff
    };
    applyModelFields(cand, ctx);
    xs.push(cand);
  };
  if (x.home) push("1","Home",x.home);
  if (x.draw) push("X","Draw",x.draw);
  if (x.away) push("2","Away",x.away);
  return xs;
}
function capPerLeague(items, maxPerLeague){
  const per=new Map(), out=[];
  for (const it of items){
    const key=String(it?.league?.id||it?.league_name||"?");
    const cur=per.get(key)||0; if (cur>=maxPerLeague) continue;
    per.set(key,cur+1); out.push(it);
  }
  return out;
}
function topKPerMarket(items, kMin=3, kMax=5){
  const buckets = { BTTS:[], "OU2.5":[], "FH_OU1.5":[], HTFT:[] };
  for (const it of items) if (buckets[it.market]) buckets[it.market].push(it);
  for (const key of Object.keys(buckets)) buckets[key].sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
  const clamp = arr => arr.slice(0, Math.max(kMin, Math.min(kMax, arr.length)));
  return {
    btts:   clamp(buckets.BTTS),
    ou25:   clamp(buckets["OU2.5"]),
    fh_ou15:clamp(buckets["FH_OU1.5"]),
    htft:   clamp(buckets.HTFT),
  };
}
function applyUefaCap(items, cap){
  const out=[]; let cnt=0;
  for (const it of items){
    if (isUEFA(it.league)) { if (cnt>=cap) continue; cnt++; }
    out.push(it);
  }
  return out;
}

/* ===== Alias layer to match legacy frontend ===== */
function aliasItem(it){
  const a = { ...it };
  // legacy confidence
  a.confidence = typeof it.confidence !== "undefined" ? it.confidence : (it.confidence_pct ?? 0);
  // legacy price on root
  if (it?.odds && typeof it.odds.price !== "undefined") a.price = Number(it.odds.price);
  // legacy names
  if (it.home && !a.home_name) a.home_name = it.home;
  if (it.away && !a.away_name) a.away_name = it.away;
  // kickoff timestamp if frontend sorts by number
  a.kickoff_ts = (() => {
    const s = it.kickoff_utc || it.kickoff;
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : null;
  })();
  return a;
}

/* =========================
 *  Handler
 * ========================= */
export default async function handler(req,res){
  const trace=[];
  try{
    const now=new Date(); const ymd=ymdInTZ(now, TZ);
    let slot=String(req.query.slot||"auto").toLowerCase();
    if (!["late","am","pm"].includes(slot)) slot=pickSlotAuto(now);
    const weekend=isWeekend(ymd);

    const unionKey=`vb:day:${ymd}:${slot}`;
    const fullKey =`vbl_full:${ymd}:${slot}`;
    const union=kvToItems(await kvGET(unionKey, trace));
    const full =kvToItems(await kvGET(fullKey,  trace));
    const base = full.items.length ? full.items : union.items;

    if (!base.length) {
      return res.status(200).json({
        ok:true, ymd, slot, source:null,
        items:[], tickets:{ btts:[], ou25:[], fh_ou15:[], htft:[], BTTS:[], OU25:[], FH_OU15:[], HTFT:[] },
        one_x_two: [], debug:{ trace }
      });
    }

    // Svi kandidati (BTTS/OU/FH/HTFT), real-odds confidence
    const candidates=[]; for (const f of base) candidates.push(...fromMarkets(f));

    // Rang po confidence, UEFA cap, per-league cap
    const ranked = candidates.slice().sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
    const afterUefa = applyUefaCap(ranked, UEFA_DAILY_CAP);
    const leagueCapped = capPerLeague(afterUefa, VB_MAX_PER_LEAGUE);

    // Football tab (kombinovani topN)
    const topN = leagueCapped.slice(0, VB_LIMIT);

    // Tiketi: topK po tržištu (garantuje FH tiket ako postoji ponuda)
    const tickets = topKPerMarket(leagueCapped, 3, 5);

    // 1x2 ponude (po slot cap-u + per-liga)
    const oneXtwoAll=[]; for (const f of base) oneXtwoAll.push(...oneXtwoOffers(f));
    oneXtwoAll.sort((a,b)=>(b.confidence_pct||0)-(a.confidence_pct||0));
    const oneXtwoCap = oneXtwoCapForSlot(slot, weekend);
    const one_x_two_raw = capPerLeague(oneXtwoAll, VB_MAX_PER_LEAGUE).slice(0, oneXtwoCap);

    // ===== Apply aliasing so the legacy UI can render immediately
    const items = topN.map(aliasItem);
    const one_x_two = one_x_two_raw.map(aliasItem);
    const ticketsAliased = {
      btts:    tickets.btts.map(aliasItem),
      ou25:    tickets.ou25.map(aliasItem),
      fh_ou15: tickets.fh_ou15.map(aliasItem),
      htft:    tickets.htft.map(aliasItem),
      // Upper-case aliases (if the UI expects these keys)
      BTTS:    tickets.btts.map(aliasItem),
      OU25:    tickets.ou25.map(aliasItem),
      FH_OU15: tickets.fh_ou15.map(aliasItem),
      HTFT:    tickets.htft.map(aliasItem),
    };

    return res.status(200).json({
      ok:true, ymd, slot, source: full.items.length?"vbl_full":"vb:day",
      items, tickets: ticketsAliased, one_x_two, debug:{ trace }
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
