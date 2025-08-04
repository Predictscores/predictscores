export default async function getSportMonksFixtures(date, apiKey) {
  const url = `https://soccer.sportmonks.com/api/v2.0/fixtures/date/${date}?include=localTeam,visitorTeam,league&api_token=${apiKey}&tz=UTC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("SportMonks API error " + res.status);
  const data = await res.json();
  // Dodaj .data za kompatibilnost
  return data.data || [];
}
