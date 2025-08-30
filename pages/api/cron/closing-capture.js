// pages/api/cron/closing-capture.js
// Hvatamo "closing" consensus oko KO (±10 min) i snimamo u vb:close:<fixture_id>.
// Pozivati na 5–10 min, ili iz noćnog joba sa days=1–2.

export const config = { runtime: "nodejs" };

const TZ = process.env.APP_TZ || "Europe/Belgrade";
const AF_BASE = process.env.API_FOOTBALL_BASE || "https://v3.football.api-sports.io";
const AF_KEY = process.env.NEXT_PUBLIC_API_FOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const CLOSING_WINDOW_MIN = Number(process.env.CLOSING_WINDOW_MIN ?? 10);

function ymdInTZ(d = new Date(), tz = TZ) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}
function minsDiff(aISO, b = new Date()) {
  if (!aISO) return 9999;
  const t = new Date(aISO.replace(" ", "T") + (aISO.endsWith("Z") ? "" : "Z"));
  return Math.round((t.getTime() - b.getTime()) / 60000);
}
async function kvSet(key, value, ttlSec = 0) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  const body = new URLSearchParams();
  body.set("value", typeof value === "string" ? value : JSON.stringify(value));
  if (ttlSec > 0) body.set("ex", String(ttlSec));
  const r = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }, body,
  });
  return r.ok;
}
async function af(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${AF_BASE}${path}?${qs}`;
  const r = await fetch(url, { headers: { "x-apisports-key": AF_KEY }, cache: "no-store" });
  if (!r.ok) throw new Error(`AF ${path} ${r.status}`);
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) throw new Error(`AF error: ${JSON.stringify(j.errors)}`);
  return j;
}
function median(arr) {
  if (!arr || arr.length === 0) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}

export default async function handler(req, res) {
  try {
    const days = Math.max(1, Number(req.query.days ?? 1));
    const out = [];
    for (let i=0; i<days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ymd = ymdInTZ(d);

      // 1) Sve današnje fiksture
      const fx = await af("/fixtures", { date: ymd });
      const fixtures = (fx.response || []).map(r => ({
        id: r.fixture?.id,
        kickoff: r.fixture?.date?.replace("T", " ").slice(0,16) || null,
        status: r.fixture?.status?.short || "",
      })).filter(x => x.id);

      // 2) Za one u prozoru oko KO (±CLOSING_WINDOW_MIN), pokupi kvote i izračunaj consensus
      const odds = await af("/odds", { date: ymd, page: 1 });
      const totalPages = Number(odds?.paging?.total || 1);
      const all = [];
      for (let p=1; p<=totalPages; p++) {
        const j = p===1 ? odds : await af("/odds", { date: ymd, page: p });
        (j.response || []).forEach(o => all.push(o));
      }

      for (const f of fixtures) {
        const mdiff = Math.abs(minsDiff(f.kickoff));
        if (mdiff > CLOSING_WINDOW_MIN) continue;

        const rel = all.filter(o => o.fixture?.id === f.id);
        if (!rel.length) continue;

        const prices = [];
        for (const o of rel) {
          const bkm = o?.bookmakers || [];
          for (const b of bkm) {
            const bets = b?.bets || [];
            const win1x2 = bets.find(bb => (bb.name || "").toLowerCase().includes("match winner") || (bb.id === 1));
            if (!win1x2) continue;
            for (const v of (win1x2.values || [])) {
              const pr = Number(v.odd);
              if (Number.isFinite(pr) && pr > 1.01) prices.push(pr);
            }
          }
        }
        const consensusPrice = median(prices);
        if (!consensusPrice) continue;

        await kvSet(`vb:close:${f.id}`, {
          ymd, fixture_id: f.id, price: consensusPrice, implied: 1/consensusPrice, kickoff: f.kickoff, status: f.status, ts: Date.now()
        });
        out.push(f.id);
      }
    }

    return res.status(200).json({ ok: true, captured: out.length, fixtures: out.slice(0,50) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
