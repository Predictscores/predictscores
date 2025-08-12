// FILE: pages/api/cron/rebuild.js
// Triggovano Vercel cron-om: rebuild locked pin za današnji dan

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

function beogradDayKey(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
}

export default async function handler(req, res) {
  try {
    const today = beogradDayKey();
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = `${proto}://${req.headers.host}`;
    const url = `${origin}/api/value-bets-locked?rebuild=1&date=${encodeURIComponent(today)}`;

    const r = await fetch(url, { headers: { "x-cron": "1" } });
    const text = await r.text();

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      rebuilt_for: today,
      body: safeJSON(text)
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}

function safeJSON(s){
  try{ return JSON.parse(s); }catch{ return s; }
}
