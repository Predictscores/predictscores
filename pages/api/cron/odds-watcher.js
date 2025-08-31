// pages/api/cron/odds-watcher.js
// ⚠️ Ovaj fajl je ranije greškom sadržao GitHub Actions YAML i rušio build.
// Sada je bezbedan stub. Pravi watcher je /api/cron/refresh-odds i /api/cron/closing-capture.

export default async function handler(req, res) {
  // opcionalno: proslijedi iste query parametre pravoj ruti, ali ovde samo jasno vratimo status
  res.status(410).json({
    ok: false,
    disabled: true,
    note:
      "Use /api/cron/refresh-odds (window [-2h,+6h]) or /api/cron/closing-capture ([-15m,+5m]). This route is deprecated.",
  });
}
