// FILE: lib/sources/apiFootball.js

/**
 * Fetch all fixtures for a given date with status NS (Not Started)
 * using API-Football v3 free plan.
 */
export async function fetchApiFootballFixtures(date) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error("Missing API_FOOTBALL_KEY env var");

  const url = `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(
    date
  )}&status=NS`;
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": "v3.football.api-sports.io",
      "x-rapidapi-key": apiKey,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`API-Football fetch failed ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  // `response` je niz mečeva
  return Array.isArray(json.response) ? json.response : [];
}
