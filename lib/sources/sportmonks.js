// lib/sources/sportmonks.js
export async function fetchSportmonksFixtures(date) {
  const apiKey = process.env.SPORTMONKS_KEY;
  if (!apiKey) throw new Error("Missing SPORTMONKS_KEY env var");

  const url = `https://soccer.sportmonks.com/api/v2.0/fixtures/date/${encodeURIComponent(
    date
  )}?include=localTeam,visitorTeam,league&api_token=${encodeURIComponent(
    apiKey
  )}&tz=UTC`;

  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SportMonks fetch failed ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}
