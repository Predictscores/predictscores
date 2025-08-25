// pages/api/cron/rebuild.js
import { kv } from '@vercel/kv';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  try {
    const now = new Date();
    const ymd = now.toISOString().slice(0, 10);

    // Slot iz query param ili autodetekcija
    let slot = req.query.slot;
    if (!slot) {
      const hour = now.getUTCHours() + 2; // CET
      if (hour >= 0 && hour < 10) slot = "late";
      else if (hour >= 10 && hour < 15) slot = "am";
      else slot = "pm";
    }

    // Ovde ide tvoj kod za povlačenje ponuda iz API (ostaje isti kao pre)
    const offers = []; // TODO: zameni svojim fetch logikom

    // Upisi slot key
    const slotKey = `vb:day:${ymd}:${slot}`;
    await kv.set(slotKey, offers);

    // Union key (opciono, možeš zadržati ako ga koristiš za debug)
    const unionKey = `vb:day:${ymd}:union`;
    let union = (await kv.get(unionKey)) || [];
    union = [...union, ...offers];
    await kv.set(unionKey, union);

    res.status(200).json({
      ok: true,
      slot,
      count_slot: offers.length,
    });
  } catch (e) {
    console.error("rebuild error", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
