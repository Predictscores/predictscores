// pages/api/cron/refresh-odds.js
export const config = { api: { bodyParser: false } };

/* ── TZ (samo TZ_DISPLAY) ── */
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB", { timeZone: raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();

/* ── KV backends (Vercel KV / Upstash) ── */
function kvBackends() {
  const out = [];
  const aU = process.env.KV_REST_API_URL, aT = process.env.KV_REST_API_TOKEN;
  const bU = process.env.UPSTASH_REDIS_REST_URL, bT = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (aU && aT) out.push({ flavor:"vercel-kv", url:aU.replace(/\/+$/,""), tok:aT });
  if (bU && bT) out.push({ flavor:"upstash-redis", url:bU.replace(/\/+$/,""), tok:bT });
  return out;
}
async function kvGETraw(key) {
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${b.tok}` }, cache:"no-store" });
      if (!r.ok) continue;
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      if (raw) return { raw, flavor:b.flavor };
    } catch {}
  }
  return { raw:null, flavor:null };
}
async function kvSET(key, value) {
  const saves = [];
  const body = (typeof value === "string") ? value : JSON.stringify(value);
  for (const b of kvBackends()) {
    try {
      const r = await fetch(`${b.url}/set/${encodeURIComponent(key)}`,{
        method:"POST", headers:{ Authorization:`Bearer ${b.tok}`, "Content-Type":"application/json" }, cache:"no-store", body
      });
      saves.push({ flavor:b.flavor, ok:r.ok });
    } catch (e) {
      saves.push({ flavor:b.flavor, ok:false, error:String(e?.message||e) });
    }
  }
  return saves;
}

const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hourInTZ = (d, tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12:false, hour:"2-digit" }).format(d));
function canonicalSlot(x){ x=String(x||"auto").toLowerCase(); return x==="late"||x==="am"||x==="pm"?x:"auto"; }
function autoSlot(d,tz){ const h=hourInTZ(d,tz); return h<10?"late":(h<15?"am":"pm"); }

/* ── API-Football odds ── */
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY  = process.env.API_FOOTBALL_KEY;

/* ── The Odds API (ODDS_API) ── */
const OA_BASE = "https://api.the-odds-api.com/v4";
const OA_KEY  = process.env.ODDS_API_KEY;
const OA_DAILY_LIMIT = 15;
const TRUSTED = new Set([
  "Pinnacle","bet365","Bet365","William Hill","WilliamHill","Bwin","Unibet","Marathon","Marathonbet",
  "10Bet","10bet","Betfair","Betway","888sport","Betano","DraftKings","FanDuel"
]);
const OA_BOOKMAKER_SLUGS = [
  "pinnacle","bet365","williamhill","bwin","unibet","marathonbet","10bet","betfair","betway","888sport","betano","draftkings","fanduel"
].join(",");

/* ── helpers ── */
const norm = s => String(s||"")
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/\b(FK|FC|SC|AC|CA|CF|CD|UD|SAD|IF|AFC|U\d{2}|U-\d{2})\b/gi,"")
  .replace(/[^a-z0-9]+/gi," ").trim().replace(/\s+/g," ").toLowerCase();

function teamKey(h,a){ return `${norm(h)}|${norm(a)}`; }

function similarTeams(h1,a1,h2,a2) {
  const t1 = [norm(h1), norm(a1)];
  const t2 = [norm(h2), norm(a2)];
  return (t1[0]===t2[0] && t1[1]===t2[1]) || (t1[0]===t2[1] && t1[1]===t2[0]) ||
         (t2[0].includes(t1[0]) && t2[1].includes(t1[1])) ||
         (t2[1].includes(t1[0]) && t2[0].includes(t1[1]));
}

async function afOddsByFixture(fid){
  if(!AF_KEY) return null;
  const r = await fetch(`${AF_BASE}/odds?fixture=${fid}`, { headers:{ "x-apisports-key": AF_KEY }, cache:"no-store" });
  if(!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j?.response?.[0]?.bookmakers || [];
}
function best1x2FromAF(bookmakers){
  let booksCount = 0;
  let best = { H:null, D:null, A:null };
  for (const b of (bookmakers||[])) {
    const name = String(b?.name||"");
    if (!TRUSTED.has(name)) continue;
    for (const bet of (b?.bets||[])) {
      const nm = String(bet?.name||"").toLowerCase();
      if (!(nm.includes("match winner") || nm.includes("1x2") || nm.includes("fulltime") || nm.includes("full time"))) continue;
      booksCount++;
      for (const v of (bet?.values||[])) {
        const lbl = String(v?.value||"").toUpperCase().replace(/\s+/g,"");
        const odd = Number(v?.odd); if (!Number.isFinite(odd)) continue;
        if (/(HOME|^1$)/.test(lbl)) best.H = Math.max(best.H||0, odd);
        else if (/(DRAW|^X$)/.test(lbl)) best.D = Math.max(best.D||0, odd);
        else if (/(AWAY|^2$)/.test(lbl)) best.A = Math.max(best.A||0, odd);
      }
    }
  }
  return { best, booksCount };
}

async function oaCanCall(ymd){
  const { raw } = await kvGETraw(`oa:used:${ymd}`);
  const used = Number(raw) || 0;
  return { allowed: used < OA_DAILY_LIMIT, used };
}
async function oaMarkUsed(ymd, inc=1){ 
  const { raw } = await kvGETraw(`oa:used:${ymd}`); 
  const used = Number(raw) || 0; 
  await kvSET(`oa:used:${ymd}`, String(used + inc)); 
  return used + inc;
}

/* Jedan ODDS_API upit: upcoming soccer H2H */
async function oaUpcomingH2H() {
  if (!OA_KEY) return null;
  const url = `${OA_BASE}/sports/upcoming/odds?apiKey=${encodeURIComponent(OA_KEY)}&regions=eu,uk,us&markets=h2h&bookmakers=${encodeURIComponent(OA_BOOKMAKER_SLUGS)}&oddsFormat=decimal&dateFormat=iso`;
  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) return null;
  const arr = await r.json().catch(()=>null);
  if (!Array.isArray(arr)) return null;

  const map = new Map();
  for (const ev of arr) {
    const home = ev?.home_team, away = ev?.away_team;
    const bms  = ev?.bookmakers || [];
    if (!home || !away || !bms.length) continue;

    let booksCount = 0;
    const best = { H:null, D:null, A:null };
    for (const b of bms) {
      const title = String(b?.title||"").trim();
      if (!TRUSTED.has(title)) continue;
      for (const m of (b?.markets||[])) {
        const key = String(m?.key||"").toLowerCase();
        if (key !== "h2h") continue;
        booksCount++;
        for (const o of (m?.outcomes||[])) {
          const name = String(o?.name||"").toUpperCase();
          const price = Number(o?.price);
          if (!Number.isFinite(price)) continue;
          if (name === "HOME") best.H = Math.max(best.H||0, price);
          else if (name === "AWAY") best.A = Math.max(best.A||0, price);
          else if (name === "DRAW") best.D = Math.max(best.D||0, price);
        }
      }
    }
    const key = teamKey(home, away);
    if (booksCount > 0) map.set(key, { best, booksCount, home, away });
  }
  return map;
}

function withPick(it, best){
  if (it?.selection_label) return it;
  const cand=[["Home",best.H],["Draw",best.D],["Away",best.A]].filter(([,p])=>Number.isFinite(p)&&p>0);
  if (!cand.length) return it;
  const fav=cand.slice().sort((a,b)=>a[1]-b[1])[0];
  return { ...it, selection_label:fav[0], pick:fav[0], pick_code:fav[0].startsWith("H")?"1":fav[0].startsWith("D")?"X":"2" };
}

export default async function handler(req, res){
  try{
    const now = new Date();
    const qSlot = canonicalSlot(req.query.slot);
    const slot  = qSlot==="auto" ? autoSlot(now, TZ) : qSlot;
    const ymd   = ymdInTZ(now, TZ);

    const { raw } = await kvGETraw(`vbl_full:${ymd}:${slot}`);
    const list = J(raw) || [];
    if (!list.length) {
      return res.status(200).json({ ok:true, ymd, slot, inspected:0, filtered:0, targeted:0, touched:0, source:"vbl_full:empty", saves:[] });
    }

    // ODDS_API: ako imamo budžet, povuci jedan "upcoming odds" i koristi za sva poklapanja
    let oa = { called:false, used_before:0, used_after:0, events:0 };
    let oaMap = null;
    if (OA_KEY) {
      const { allowed, used } = await oaCanCall(ymd);
      oa.used_before = used;
      if (allowed) {
        const tmp = await oaUpcomingH2H();
        if (tmp && tmp.size) {
          oaMap = tmp;
          await oaMarkUsed(ymd, 1);
          oa.called = true;
          oa.used_after = used + 1;
          oa.events = tmp.size;
        }
      }
    }

    let touched = 0, targeted = 0;
    const updated = [];

    for (const it of list) {
      const fid = it?.fixture_id || it?.fixture?.id || it?.id;
      const home = it?.teams?.home?.name || it?.home?.name;
      const away = it?.teams?.away?.name || it?.away?.name;

      targeted++;

      // 1) Probaj ODDS_API (ako je mapa popunjena)
      let price = null, booksCount = 0;
      if (oaMap && home && away) {
        const key = teamKey(home, away);
        let hit = oaMap.get(key);
        if (!hit) {
          let tries = 0;
          for (const [, v] of oaMap.entries()) {
            if (++tries > 50) break;
            if (similarTeams(home, away, v.home, v.away)) { hit = v; break; }
          }
        }
        if (hit) {
          const best = hit.best;
          const withSel = withPick(it, best);
          if (/^home/i.test(withSel?.selection_label||"")) price = best.H;
          else if (/^draw/i.test(withSel?.selection_label||"")) price = best.D;
          else if (/^away/i.test(withSel?.selection_label||"")) price = best.A;
          if (Number.isFinite(price) && price>1) {
            updated.push({ ...withSel, odds: { price, books_count: hit.booksCount } });
            touched++;
            continue;
          } else {
            booksCount = hit.booksCount || 0;
          }
        }
      }

      // 2) Fallback: API-Football
      const books = await afOddsByFixture(fid);
      const { best, booksCount:afBooks } = best1x2FromAF(books);
      const withSel = withPick(it, best);

      if (!Number.isFinite(price)) {
        if (/^home/i.test(withSel?.selection_label||"")) price = best.H;
        else if (/^draw/i.test(withSel?.selection_label||"")) price = best.D;
        else if (/^away/i.test(withSel?.selection_label||"")) price = best.A;
        booksCount = Math.max(booksCount, afBooks||0);
      }

      if (Number.isFinite(price) && price>1) {
        updated.push({ ...withSel, odds: { price, books_count: booksCount } });
        touched++;
      } else {
        updated.push({ ...withSel, odds: { price: withSel?.odds?.price ?? null, books_count: booksCount || (withSel?.odds?.books_count ?? 0) } });
      }
    }

    const saves = [];
    saves.push(...await kvSET(`vbl_full:${ymd}:${slot}`, updated));
    saves.push(...await kvSET(`vbl:${ymd}:${slot}`, updated));

    return res.status(200).json({
      ok:true, ymd, slot,
      inspected: list.length, filtered: 0, targeted, touched,
      source:`vbl_full:${ymd}:${slot}`,
      saves,
      oa
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
