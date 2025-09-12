// pages/api/locked-floats.js
export const config = { api: { bodyParser: false } };

/* KV (Vercel KV) */
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOK = process.env.KV_REST_API_TOKEN;
async function kvGet(key){ if(!KV_URL||!KV_TOK)return null; const r=await fetch(`${KV_URL.replace(/\/+$/,"")}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${KV_TOK}`},cache:"no-store"}); if(!r.ok)return null; const j=await r.json().catch(()=>null); return typeof j?.result==="string"?j.result:null; }
async function kvSet(key,val){ if(!KV_URL||!KV_TOK)return false; const r=await fetch(`${KV_URL.replace(/\/+$/,"")}/set/${encodeURIComponent(key)}`,{method:"POST",headers:{Authorization:`Bearer ${KV_TOK}`,"Content-Type":"application/json"},body: (typeof val==="string")?val:JSON.stringify(val)}); return r.ok; }

/* TZ */
function pickTZ(){ const raw=(process.env.TZ_DISPLAY||"Europe/Belgrade").trim(); try{ new Intl.DateTimeFormat("en-GB",{timeZone:raw}); return raw; }catch{ return "Europe/Belgrade"; } }
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

/* helpers */
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const kickoffTs = x => { const k=x?.fixture?.date||x?.fixture_date||x?.kickoff||x?.kickoff_utc||x?.ts; const d=k?new Date(k):null; return Number.isFinite(d?.getTime?.())?d.getTime():0; };
const conf = x => Number.isFinite(x?.confidence_pct)?x.confidence_pct:(Number(x?.confidence)||0);

/* API-Football odds (15 safe poziva max) */
const AF_BASE = "https://v3.football.api-sports.io";
const AF_KEY  = process.env.API_FOOTBALL_KEY;
async function afOddsByFixture(fixtureId){
  if(!AF_KEY) return null;
  const url = `${AF_BASE}/odds?fixture=${fixtureId}`;
  const r = await fetch(url, { headers:{ "x-apisports-key": AF_KEY }, cache:"no-store" });
  if(!r.ok) return null;
  const j = await r.json().catch(()=>null);
  return j?.response?.[0]?.bookmakers || [];
}

/* dnevni specijali: BTTS, O/U 2.5, HT/FT → tickets:<ymd> */
async function buildDailyTickets(ymd) {
  const raw = await kvGet(`vb:day:${ymd}:last`) || await kvGet(`vb:day:${ymd}:union`);
  const base = J(raw) || [];
  if (!base.length) return null;

  const take = base.slice(0, 12); // ≤12 AF poziva
  const btts=[], ou25=[], htft=[];

  function push(arr, it, confBoost){ arr.push({ ...it, confidence_pct: Math.min(95, Math.max(conf(it), 40) + confBoost) }); }

  for (const f of take) {
    const fid = f?.fixture_id || f?.fixture?.id || f?.id; if (!fid) continue;
    const books = await afOddsByFixture(fid); if (!books) continue;

    // BTTS
    {
      let yes=[], no=[];
      for (const b of books) for (const bet of (b?.bets||[])) {
        const nm = String(bet?.name||"").toLowerCase();
        if (nm.includes("both teams to score")) {
          for (const v of (bet?.values||[])) {
            const lbl=String(v?.value||"").toLowerCase(), odd=Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl.includes("yes")) yes.push(odd); else if (lbl.includes("no")) no.push(odd);
          }
        }
      }
      const pick = yes.length && (!no.length || Math.min(...yes) <= Math.min(...no)) ? {sel:"YES", price: Math.min(...yes)} :
                   no.length  ? {sel:"NO",  price: Math.min(...no)}  : null;
      if (pick) push(btts, { ...f, market:"BTTS", market_label:"BTTS", selection_label: pick.sel, selection: pick.sel, market_odds: pick.price }, 5);
    }

    // O/U 2.5
    {
      let over=[], under=[];
      for (const b of books) for (const bet of (b?.bets||[])) {
        const nm = String(bet?.name||"").toLowerCase();
        if (nm.includes("over/under") || nm.includes("totals")) {
          for (const v of (bet?.values||[])) {
            const lbl=String(v?.value||"").toLowerCase(), odd=Number(v?.odd);
            if (!Number.isFinite(odd)) continue;
            if (lbl.includes("over 2.5")) over.push(odd);
            if (lbl.includes("under 2.5")) under.push(odd);
          }
        }
      }
      const pick = over.length && (!under.length || Math.min(...over) <= Math.min(...under)) ? {sel:"OVER 2.5", price: Math.min(...over)} :
                   under.length ? {sel:"UNDER 2.5",price: Math.min(...under)} : null;
      if (pick) push(ou25, { ...f, market:"O/U 2.5", market_label:"O/U 2.5", selection_label: pick.sel, selection: pick.sel, market_odds: pick.price }, 5);
    }

    // HT/FT
    {
      const map = {};
      for (const b of books) for (const bet of (b?.bets||[])) {
        const nm = String(bet?.name||"").toLowerCase();
        if (nm.includes("ht/ft") || nm.includes("half time/full time")) {
          for (const v of (bet?.values||[])) {
            const lbl = String(v?.value||"").toUpperCase().replace(/\s+/g,"");
            const odd = Number(v?.odd); if (!Number.isFinite(odd)) continue;
            const norm = lbl.replace(/(^|\/)1/g,"$1HOME").replace(/(^|\/)X/g,"$1DRAW").replace(/(^|\/)2/g,"$1AWAY");
            (map[norm] ||= []).push(odd);
          }
        }
      }
      const best = Object.entries(map).map(([k,arr])=>[k, arr && arr.length ? Math.min(...arr) : Infinity]).sort((a,b)=>a[1]-b[1])[0];
      if (best && isFinite(best[1])) push(htft, { ...f, market:"HT-FT", market_label:"HT-FT", selection_label: best[0], selection: best[0], market_odds: best[1] }, 8);
    }
  }

  const sortT = (a,b)=> (conf(b)-conf(a)) || (kickoffTs(a)-kickoffTs(b));
  btts.sort(sortT); ou25.sort(sortT); htft.sort(sortT);
  await kvSet(`tickets:${ymd}`, { btts, ou25, htft });
  return { btts: btts.length, ou25: ou25.length, htft: htft.length };
}

export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = ymdInTZ(now, TZ);

    // warm=1 → samo dnevni specijali (ako ne postoje)
    if (String(req.query.warm||"") === "1") {
      const raw = await kvGet(`tickets:${ymd}`);
      if (!raw) {
        const r = await buildDailyTickets(ymd);
        return res.status(200).json({ ok:true, warm: r || { btts:0, ou25:0, htft:0 } });
      }
      return res.status(200).json({ ok:true, warm: { created:false, already:true } });
    }

    // (ostali tvoji “floats/scout” koraci ostaju kakvi jesu ili ih dodaš po potrebi)
    return res.status(200).json({ ok:true, note:"locked-floats alive" });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
