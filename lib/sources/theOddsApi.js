// lib/sources/theOddsApi.js
export async function fetchOdds(sportKey, regions = "eu", markets = "h2h,totals") {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) throw new Error("Missing ODDS_API_KEY env var");

  const url = `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(
    sportKey
  )}/odds/?apiKey=${encodeURIComponent(apiKey)}&regions=${regions}&markets=${markets}&dateFormat=iso&oddsFormat=decimal`;

  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Odds API fetch failed ${res.status}: ${body}`);
  }
  return JSON.parse(body);
}
