export const config = { api: { bodyParser: false } };

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const API_KEY  = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
const TZ       = process.env.TZ_DISPLAY || "Europe/Belgrade";

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  try { const { result } = await r.json(); return result ? JSON.parse(result) : null; } catch { return null; }
}
async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return;
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}
function ymdToday(tz=TZ){
  return new Intl.DateTimeFormat("sv-SE",{ timeZone: tz, year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
}

async function fetchInsightFor(p) {
  if (!API_KEY) return null;
  const fid = p?.fixture_id;
  if (!fid) return null;

  // API-Football form & h2h (lightweight: last 5)
  const headers = { "x-apisports-key": API_KEY };

  const homeId = p?.teams?.home?.id;
  const awayId = p?.teams?.away?.id;
  const bullets = [];

  try {
    const [formHome, formAway] = await Promise.all([
      homeId ? fetch(`https://v3.football.api-sports.io/teams/statistics?team=${homeId}&league=${p?.league?.id}&season=${p?.league?.season}`, { headers }) : null,
      awayId ? fetch(`https://v3.football.api-sports.io/teams/statistics?team=${awayId}&league=${p?.league?.id}&season=${p?.league?.season}`, { headers }) : null
    ]);
    let hForm = null, aForm = null;
    if (formHome?.ok) { const j=await formHome.json(); hForm = j?.response?.form || null; }
    if (formAway?.ok) { const j=await formAway.json(); aForm = j?.response?.form || null; }

    if (hForm || aForm) {
      const fmt = (f) => f ? `${f}` : "n/a";
      bullets.push(`Forma: ${p?.teams?.home?.name} ${fmt(hForm)} · ${p?.teams?.away?.name} ${fmt(aForm)}`);
    }
  } catch {}

  try {
    if (homeId && awayId) {
      const rh = await fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=5`, { headers });
      if (rh.ok) {
        const j = await rh.json();
        const l5 = j?.response || [];
        if (Array.isArray(l5) && l5.length) {
          let gh=0, ga=0, wh=0, wa=0, d=0;
          for (const f of l5){
            const sh = Number(f?.goals?.home||0), sa = Number(f?.goals?.away||0);
            gh += sh; ga += sa;
            if (sh>sa) wh++; else if (sh<sa) wa++; else d++;
          }
          bullets.push(`H2H (L5): ${wh}-${d}-${wa} (GF:${gh}:GA:${ga})`);
        }
      }
    }
  } catch {}

  // zaključni mini-tekst (fallback ako nema ništa)
  const pick = String(p?.selection||"").toUpperCase();
  const modelP = Number(p?.model_prob||0)*100 || null;
  const line = (p?.market_label||p?.market||"").toUpperCase().includes("BTTS 1H") ? "BTTS 1H YES" : pick;
  bullets.push(`Balans snaga daje prednost izboru **${line}**; model ${modelP ? modelP.toFixed(1) : "—"}%.`);

  return bullets;
}

export default async function handler(req, res) {
  try{
    const ymd = ymdToday();
    const unionKey = `vb:day:${ymd}:last`;
    const list = await kvGet(unionKey);
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return res.status(200).json({ updated:0, reason:"no snapshot", tried:unionKey });

    let updated = 0;
    for (const p of arr) {
      if (!p?.fixture_id) continue;
      const has = Array.isArray(p?.explain?.bullets) && p.explain.bullets.length>0;
      if (has) continue; // već ima

      const bullets = await fetchInsightFor(p);
      if (bullets && bullets.length) {
        p.explain = { ...(p.explain||{}), bullets };
        updated++;
      }
    }
    if (updated>0) await kvSet(unionKey, arr);
    return res.status(200).json({ updated, usedKey: unionKey, fetch_blocks: Math.ceil(arr.length/10) });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
