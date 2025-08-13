// FILE: pages/api/_diag-env.js
export default function handler(req, res) {
  res.status(200).json({
    API_FOOTBALL_KEY_present: !!process.env.API_FOOTBALL_KEY || !!process.env.NEXT_PUBLIC_API_FOOTBALL_KEY,
    SPORTMONKS_KEY_present: !!process.env.SPORTMONKS_KEY,
    FOOTBALL_DATA_KEY_present: !!process.env.FOOTBALL_DATA_KEY,
  });
}
