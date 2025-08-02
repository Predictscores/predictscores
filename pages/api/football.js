// pages/api/football.js
export default async function handler(req, res) {
  // placeholder dok ne dobiješ realne fudbalske izvore
  const payload = {
    footballTop: [], // kad se integrišu izvori, ovde ide top N (najmanje 3)
    generated_at: new Date().toISOString()
  };
  return res.status(200).json(payload);
}
