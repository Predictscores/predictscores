// FILE: pages/api/odds-sports.js

export default async function handler(req, res) {
  const ODDS_API_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_API_KEY) {
    return res.status(500).json({ error: 'Missing ODDS_API_KEY in env' });
  }
  try {
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports/?all=true&apiKey=${ODDS_API_KEY}`
    );
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Odds API error: ${resp.status} ${txt}`);
    }
    const data = await resp.json();
    return res.status(200).json({ sports: data });
  } catch (e) {
    console.error('odds-sports error', e);
    return res.status(500).json({ error: e.message });
  }
}
