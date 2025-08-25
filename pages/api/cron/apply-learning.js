// pages/api/cron/apply-learning.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10);

    // Odredi slot po lokalnom vremenu (Europe/Belgrade)
    const hour = now.getUTCHours() + 2; // CET = UTC+2 (letnje vreme)
    let slot = "late";
    if (hour >= 10 && hour < 15) slot = "am";
    else if (hour >= 15 && hour < 24) slot = "pm";

    // Čitaj selekcije iz aktivnog slota
    const slotKey = `vb:day:${ymd}:${slot}`;
    let items = await kv.get(slotKey);
    if (!Array.isArray(items)) items = [];

    // Primeni "learning weights" – jednostavno re-sortranje po confidence_pct
    items.sort((a, b) => (b.confidence_pct || 0) - (a.confidence_pct || 0));

    // Upisi nazad u :last
    const lastKey = `vb:day:${ymd}:last`;
    await kv.set(lastKey, items);

    // Meta sa slot info
    const metaKey = `vb:meta:${ymd}:last_meta`;
    await kv.set(metaKey, {
      built_at: new Date().toISOString(),
      slot,
      count: items.length,
    });

    res.status(200).json({
      ok: true,
      slot,
      count: items.length,
    });
  } catch (e) {
    console.error("apply-learning error", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
