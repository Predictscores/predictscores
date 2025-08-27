// pages/api/cron/refresh-odds.js
// HOT-FIX: ne koristi APIFootball v3/odds?fixture uopšte.
// Ostavlja rutu da vraća 200 OK (workflow zelen), bez spoljnjih poziva.

export default async function handler(req, res) {
  try {
    res.status(200).json({
      ok: true,
      disabled: true,
      note: "refresh-odds hot-fixed: no external odds calls (use /api/football)",
    });
  } catch {
    res.status(200).json({ ok: true, disabled: true });
  }
}
