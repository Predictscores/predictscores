// FILE: pages/api/cron/closing-capture.js
export const config = { api: { bodyParser: false } };

// ---------- KV helpers
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  try { const js = await r.json(); return js?.result ?? null; } catch { return null; }
}
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}
function toArray(raw){
  try{
    let v = raw;
    if (typeof v === "string") v = JSON.parse(v);
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object"){
      if (Array.isArray(v.value)) return v.value;
      if (Array.isArray(v.arr)) return v.arr;
      if (Array.isArray(v.data)) return v.data;
      if ("value" in v){
        const inner = v.value;
        if (typeof inner === "string") return JSON.parse(inner);
        if (Array.isArray(inner)) return inner;
      }
    }
  }catch{}
  return [];
}
const TZ = "Europe/Belgrade";
function todayYMD() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function parseKO(item){
  const iso = item?.datetime_local?.starting_at?.date_time
           || item?.datetime_local?.date_time
           || item?.time?.starting_at?.date_time
           || null;
  if (!iso) return null;
  const d = new Date(String(iso).replace(" ", "T"));
  return Number.isFinite(+d) ? d : null;
}
function minutesDiff(a,b){ return Math.round((a.getTime() - b.getTime())/60000); }
function med(nums){ const arr=[...nums].sort((x,y)=>x-y); const n=arr.length; return n? (n%2?arr[(n-1)/2]:(arr[n/2-1]+arr[n/2])/2) : null; }
function implied(p){ return p>0 ? 1/p : null; }
function pp(x){ return Number.isFinite(x)? Math.round(x*1000)/10 : null; }

// ---------- API-FOOTBALL odds fetch + parse
const AF_BASE = "https://v3.football.api-sports.io";
function afKey(){ return process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || ""; }

async function fetchOddsForFixture(fid){
  const key = afKey(); if (!key) return null;
  const r = await fetch(`${AF_BASE}/odds?fixture=${fid}`, { headers: { "x-apisports-key": key } });
  if (!r.ok) return null;
  const js = await r.json().catch(()=>null);
  return js?.response || null;
}

// map our market/selection to AF "bets"
function pickOddFromBook(bk, market, selection){
  const bets = bk?.bets || [];
  const m = String(market||"").toUpperCase();
  const s = String(selection||"").toUpperCase();

  // 1X2
  if (m === "1X2"){
    const bet = bets.find(b => /1x2|match winner/i.test(b?.name||""));
    if (!bet) return null;
    const lab = s==="1" ? /home/i : s==="2" ? /away/i : /^draw$/i;
    const v = bet.values?.find(v => lab.test(v?.value||""));
    return v ? Number(v.odd) : null;
  }

  // BTTS
  if (m === "BTTS"){
    const bet = bets.find(b => /both teams to score/i.test(b?.name||""));
    if (!bet) return null;
    const lab = /YES/.test(s) ? /^yes$/i : /^no$/i;
    const v = bet.values?.find(v => lab.test(v?.value||""));
    return v ? Number(v.odd) : null;
  }

  // OU 2.5 (strict)
  if (m === "OU"){
    const bet = bets.find(b => /over\/under/i.test(b?.name||""));
    if (!bet) return null;
    const v = bet.values?.find(v => /^over 2\.5$|^under 2\.5$/i.test(v?.value||""));
    if (!v) return null;
    if (/OVER/.test(s) && /^over 2\.5$/i.test(v.value)) return Number(v.odd);
    if (/UNDER/.test(s) && /^under 2\.5$/i.test(v.value)) return Number(v.odd);
    return null;
  }

  return null;
}

export default async function handler(req,res){
  try{
    const ymd = todayYMD();
    const unionRaw = await kvGet(`vb:day:${ymd}:last`);
    const union = toArray(unionRaw);
    if (!union.length) return res.status(200).json({ ok:true, updated:0, note:"no union" });

    const now = new Date();
    const TRUSTED = String(process.env.TRUSTED_BOOKIES||"")
      .split(/[,|]/).map(s=>s.trim().toLowerCase()).filter(Boolean);

    const WIN_MIN = Number(process.env.CLV_WINDOW_MIN ?? -10); // min pre KO
    const WIN_MAX = Number(process.env.CLV_WINDOW_MAX ?? 20);  // min posle KO

    let updated = 0, scanned = 0;

    for (const p of union){
      const fid = p?.fixture_id; if (!fid) continue;
      const ko = parseKO(p); if (!ko) continue;

      const minToKo = minutesDiff(ko, now);
      if (minToKo < WIN_MIN || minToKo > WIN_MAX) continue;

      scanned++;

      const has = await kvGet(`vb:close:${fid}`);
      try{
        const parsed = typeof has==="string" ? JSON.parse(has) : has;
        if (parsed && Number.isFinite(parsed.trusted_median_close)) continue;
      }catch{}

      const resp = await fetchOddsForFixture(fid);
      if (!resp || !resp.length) continue;

      const oddsByBook = [];
      for (const r of resp){
        const bks = r?.bookmakers || [];
        for (const bk of bks){
          const name = String(bk?.name||"").toLowerCase();
          if (!TRUSTED.includes(name)) continue;
          const odd = pickOddFromBook(bk, p.market, p.selection);
          if (Number.isFinite(odd)) oddsByBook.push(odd);
        }
      }
      if (!oddsByBook.length) continue;

      const medOdds = med(oddsByBook);
      const imps = oddsByBook.map(o=>implied(o)).filter(Number.isFinite);
      const spread = imps.length ? (Math.max(...imps)-Math.min(...imps)) : null;

      await kvSet(`vb:close:${fid}`, {
        trusted_median_close: medOdds || null,
        spread_close_pp: pp(spread) ?? null,
        books_used: oddsByBook.length,
        at: new Date().toISOString()
      });
      updated++;
    }

    return res.status(200).json({ ok:true, updated, scanned });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e?.message||e) });
  }
}
