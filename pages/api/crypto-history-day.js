// pages/api/crypto-history-day.js
export const config = { api: { bodyParser: false } };

// ---- KV helpers (isti stil kao ostale rute) ----
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
      const j = await r.json().catch(()=>null);
      const raw = typeof j?.result === "string" ? j.result : null;
      if (!r.ok) continue;
      return raw;
    } catch {}
  }
  return null;
}
const J = s=>{ try{ return JSON.parse(String(s||"")); }catch{ return null; } };
const isValidYmd = (s)=> /^\d{4}-\d{2}-\d{2}$/.test(String(s||""));
function pickTZ() {
  const raw = (process.env.TZ_DISPLAY || "Europe/Belgrade").trim();
  try { new Intl.DateTimeFormat("en-GB",{ timeZone:raw }); return raw; } catch { return "Europe/Belgrade"; }
}
const TZ = pickTZ();
const ymdInTZ = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

// ---- core ----
export default async function handler(req, res) {
  try {
    const qYmd = String(req.query.ymd||"").trim();
    if (!isValidYmd(qYmd)) {
      return res.status(200).json({ ok:false, error:"Provide ymd=YYYY-MM-DD" });
    }

    // Učitaj index i uzmi poslednjih N id-eva (dovoljno za jedan dan)
    const idxRaw = await kvGETraw("crypto:history:index");
    const ids = (J(idxRaw)||[]).slice(-600).reverse(); // recent → old

    const items = [];
    for (const id of ids) {
      const raw = await kvGETraw(`crypto:history:item:${id}`);
      const it = J(raw);
      if (!it || !it.ts) continue;
      // Poredi po danu u zadatom TZ
      const y = ymdInTZ(new Date(Number(it.ts)), TZ);
      if (y === qYmd) {
        items.push({
          id: id,
          ts: it.ts,
          symbol: it.symbol || it.symbol1 || it.ticker,
          name: it.name || null,
          exchange: it.exchange || null,
          pair: it.pair || null,
          side: it.side || null,
          entry: it.entry ?? null,
          sl: it.sl ?? null,
          tp: it.tp ?? null,
          rr: it.rr ?? null,
          confidence_pct: it.confidence_pct ?? null,
          valid_until: it.valid_until ?? null,
          outcome: it.outcome || null,     // "tp" | "sl" | "expired"
          win: (typeof it.win!=="undefined" ? it.win : (typeof it.won!=="undefined"?it.won:null)),
          exit_price: it.exit_price ?? null,
          realized_rr: it.realized_rr ?? null,
          evaluated_ts: it.evaluated_ts ?? null
        });
      } else if (items.length && y !== qYmd) {
        // čim smo prošli kroz dan i već imamo neke — prekini radi performansi
        break;
      }
    }

    // Rezime (računa se nad odlučenim; expired ne ulazi u win-rate)
    const decided = items.filter(i => (i.outcome==="tp"||i.outcome==="sl"));
    const wins = decided.filter(i => i.outcome==="tp").length;
    const avgRR = decided.length ? decided.reduce((s,i)=> s + (Number(i.realized_rr)||0), 0)/decided.length : null;
    const medianRR = decided.length
      ? decided.map(i=>Number(i.realized_rr)||0).sort((a,b)=>a-b)[Math.floor(decided.length/2)]
      : null;
    const winRate = decided.length ? Math.round(100*wins/decided.length) : null;

    return res.status(200).json({
      ok:true,
      ymd:qYmd, tz:TZ,
      totals: {
        count: items.length,
        decided: decided.length,
        win_rate_pct: winRate,
        avg_rr: avgRR,
        median_rr: medianRR
      },
      items
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
