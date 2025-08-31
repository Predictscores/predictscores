// pages/api/history-check.js
// Uklonjen hard-kodovan domen; baza se uzima iz request headera.

function getBaseFromReq(req) {
  const proto =
    req.headers["x-forwarded-proto"] ||
    (req.headers["x-forwarded-protocol"] ? req.headers["x-forwarded-protocol"] : "https");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  try {
    const base = getBaseFromReq(req);
    // Ako želiš, ovde možeš pingovati druge interne rute: `${base}/api/...`
    // Za sada samo potvrda da je baza korektno detektovana.
    res.status(200).json({ ok: true, base });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
