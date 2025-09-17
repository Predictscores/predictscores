// pages/api/locked-floats.js
import { afxGetJson, afxOddsByFixture } from "../../lib/sources/apiFootball";

export const config = { api: { bodyParser: false } };

/* ---------- TZ ---------- */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/* ---------- KV ---------- */
const KV_URL = process.env.KV_REST_API_URL?.replace(/\/+$/,"");
const KV_TOK = process.env.KV_REST_API_TOKEN;
const okKV   = !!(KV_URL && KV_TOK);
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };

async function kvGet(key){
  if(!okKV) return null;
  const r=await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${KV_TOK}`},cache:"no-store"});
  if(!r.ok) return null; const j=await r.json().catch(()=>null);
  return typeof j?.result==="string" ? j.result : null;
}
async function kvSet(key,val){
  if(!okKV) return false;
  const r=await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`,{
    method:"POST",headers:{Authorization:`Bearer ${KV_TOK}`,"Content-Type":"application/json"},
    body: (typeof val==="string")?val:JSON.stringify(val)
  });
  return r.ok;
}

function mapFixtureToBase(fx){
  // Dovoljno meta da refresh/rebuild mogu da rade; pick/conf/odds će se dodati posle.
  return {
    fixture_id: fx?.fixture?.id,
    fixture: {
      id: fx?.fixture?.id,
      date: fx?.fixture?.date,
      timezone: fx?.fixture?.timezone || TZ,
    },
    league: {
      id: fx?.league?.id,
      name: fx?.league?.name,
      country: fx?.league?.country,
      season: fx?.league?.season,
      round: fx?.league?.round,
    },
    teams: {
      home: { id: fx?.teams?.home?.id, name: fx?.teams?.home?.name, logo: fx?.teams?.home?.logo, winner: fx?.teams?.home?.winner ?? null },
      away: { id: fx?.teams?.away?.id, name: fx?.teams?.away?.name, logo: fx?.teams?.away?.logo, winner: fx?.teams?.away?.winner ?? null },
    },
    kickoff_utc: fx?.fixture?.date,
    market: "1X2",
    market_label: "1X2",
    // polja koja UI voli, ostavljena prazna da ih popuni refresh-odds/insights kasnije:
    selection_label: null,
    odds: { price: null, books_count: 0 },
    confidence_pct: 50
  };
}

/* ---------- Specijali (BTTS / O/U 2.5 / HT-FT) – skromno, ≤ 12 AF poziva ---------- */
const conf = x => Number.isFinite(x?.confidence_pct)?x.confidence_pct:(Number(x?.confidence)||0);
const kts = x => { const k=x?.fixture?.date||x?.kickoff||x?.kickoff_utc||x?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };

async function buildDailyTicketsFromAF(fixtures){
  // Uzimamo najviše 12 prvih utakmica (da ostanemo daleko ispod 6000/dan)
  const take = fixtures.slice(0, 12);
  const btts=[], ou25=[], htft=[];
  let budgetStop = false;

  for (const f of take) {
    if (budgetStop) break;
    const fid = f?.fixture?.id || f?.fixture_id; if(!fid) continue;
    const oddsResp = await afxOddsByFixture(fid, { priority: "P3" });
    if (!oddsResp) { budgetStop = true; break; }
    const books = oddsResp?.response?.[0]?.bookmakers || [];
    // BTTS
    {
      let yes=[], no=[];
      for (const b of books) for (const bet of (b?.bets||[])) {
        const nm=String(bet?.name||"").toLowerCase();
        if (nm.includes("both teams to score")){
          for (const v of (bet?.values||[])) {
            const lbl=String(v?.value||"").toLowerCase(), odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if (lbl.includes("yes")) yes.push(odd); else if (lbl.includes("no")) no.push(odd);
          }
        }
      }
      const pick = yes.length && (!no.length || Math.min(...yes) <= Math.min(...no)) ? {sel:"YES", price: Math.min(...yes)} :
                   no.length  ? {sel:"NO",  price: Math.min(...no)}  : null;
      if (pick) btts.push({ ...mapFixtureToBase(f), market:"BTTS", market_label:"BTTS", selection_label: pick.sel, selection: pick.sel, market_odds: pick.price, confidence_pct: Math.max(55, conf(f)) });
    }
    // O/U 2.5
    {
      let over=[], under=[];
      for (const b of books) for (const bet of (b?.bets||[])) {
        const nm=String(bet?.name||"").toLowerCase();
        if (nm.includes("over/under") || nm.includes("totals")){
          for (const v of (bet?.values||[])) {
            const lbl=String(v?.value||"").toLowerCase(), odd=Number(v?.odd);
            if(!Number.isFinite(odd)) continue;
            if (lbl.includes("over 2.5")) over.push(odd);
            if (lbl.includes("under 2.5")) under.push(odd);
          }
        }
      }
      const pick = over.length && (!under.length || Math.min(...over) <= Math.min(...under)) ? {sel:"OVER 2.5", price: Math.min(...over)} :
                   under.length ? {sel:"UNDER 2.5", price: Math.min(...under)} : null;
      if (pick) ou25.push({ ...mapFixtureToBase(f), market:"O/U 2.5", market_label:"O/U 2.5", selection_label: pick.sel, selection: pick.sel, market_odds: pick.price, confidence_pct: Math.max(55, conf(f)) });
    }
    // HT/FT
    {
      const map = {};
      for (const b of books) for (const bet of (b?.bets||[])) {
        const nm=String(bet?.name||"").toLowerCase();
        if (nm.includes("ht/ft") || nm.includes("half time/full time")){
          for (const v of (bet?.values||[])) {
            const lbl=String(v?.value||"").toUpperCase().replace(/\s+/g,"");
            const odd=Number(v?.odd); if(!Number.isFinite(odd)) continue;
            const norm=lbl.replace(/(^|\/)1/g,"$1HOME").replace(/(^|\/)X/g,"$1DRAW").replace(/(^|\/)2/g,"$1AWAY");
            (map[norm] ||= []).push(odd);
          }
        }
      }
      const best = Object.entries(map).map(([k,arr])=>[k, arr && arr.length ? Math.min(...arr) : Infinity]).sort((a,b)=>a[1]-b[1])[0];
      if (best && isFinite(best[1])) htft.push({ ...mapFixtureToBase(f), market:"HT-FT", market_label:"HT-FT", selection_label: best[0], selection: best[0], market_odds: best[1], confidence_pct: Math.max(60, conf(f)) });
    }
  }

  const sortT = (a,b)=> (conf(b)-conf(a)) || (kts(a)-kts(b));
  btts.sort(sortT); ou25.sort(sortT); htft.sort(sortT);
  return { btts, ou25, htft, budgetStop };
}

/* ---------- handler ---------- */
export default async function handler(req, res){
  try{
    const today = ymdInTZ(new Date(), TZ);

    // WARM: napravi bazu i (ako treba) dnevne tikete
    if(String(req.query.warm||"") === "1"){
      let baseCount = 0, madeBase = false, ticketsInfo = null;
      let budgetStop = false;

      // 1) BASE SNAPSHOT: ako ne postoji, povuci fixtures za današnji datum i upiši vb:day:<YMD>:(last|union)
      const lastRaw = await kvGet(`vb:day:${today}:last`);
      if (!J(lastRaw)?.length){
        const fixturesResp = await afxGetJson(
          `/fixtures?date=${today}&timezone=${encodeURIComponent(TZ)}`,
          {
            cacheKey: `af:fixtures:${today}:${TZ}`,
            ttlSeconds: 2 * 3600,
            priority: "P2",
          }
        );
        if (!fixturesResp) {
          budgetStop = true;
        }
        const fixtures = Array.isArray(fixturesResp?.response) ? fixturesResp.response : [];
        const base = fixtures.map(mapFixtureToBase).filter(x=>x.fixture_id);
        if (base.length){
          await kvSet(`vb:day:${today}:last`, base);
          await kvSet(`vb:day:${today}:union`, base);
          madeBase = true;
          baseCount = base.length;
        }
      }else{
        baseCount = (J(lastRaw)||[]).length;
      }

      // 2) DAILY TICKETS: ako ne postoji tickets:<YMD>, napravi ga iz AF odds (≤12 poziva)
      const tRaw = await kvGet(`tickets:${today}`);
      if(!J(tRaw)){
        const fixtures = J(await kvGet(`vb:day:${today}:last`)) || [];
        const { btts, ou25, htft, budgetStop: ticketsBudgetStop } = await buildDailyTicketsFromAF(fixtures);
        if (btts.length || ou25.length || htft.length) {
          await kvSet(`tickets:${today}`, { btts, ou25, htft });
        }
        ticketsInfo = { btts: btts.length, ou25: ou25.length, htft: htft.length };
        budgetStop = budgetStop || ticketsBudgetStop;
      }else{
        const t = J(tRaw); ticketsInfo = { btts: (t?.btts||[]).length, ou25: (t?.ou25||[]).length, htft:(t?.htft||[]).length };
      }

      return res.status(200).json({ ok:true, warm:{ base_created:madeBase, base_count:baseCount, tickets:ticketsInfo, budget_exhausted:budgetStop } });
    }

    // Bez warm-a ne radimo ništa teško (ovaj endpoint se zove iz crona da popuni bazu)
    return res.status(200).json({ ok:true, note:"locked-floats alive" });

  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
