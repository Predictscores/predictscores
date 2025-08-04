export default async function getOdds(sportKey, apiKey) {
  // Ovaj endpoint vraća SVE mečeve sa kvotama (možeš filtrirati po datumu ako treba)
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("The Odds API error " + res.status);
  const data = await res.json();
  return data;
}
