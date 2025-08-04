// pages/api/select-matches.js
import { fetchSportmonksFixtures } from "../../lib/sources/sportmonks";

async function fetchSportmonksFixturesWithRetry(date, retries = 3, baseDelay = 500) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetchSportmonksFixtures(date);
    } catch (e) {
      const isServerError =
        e?.message?.includes("500") || e?.message?.includes("503") || e?.message?.toLowerCase().includes("incorrect request");
      if (attempt === retries - 1 || !isServerError) {
        throw e;
      }
      console.warn(`SportMonks fetch attempt ${attempt + 1} failed, retrying...`, e.message);
      await new Promise((r) => setTimeout(r, baseDelay * (attempt + 1)));
    }
  }
  throw new Error("Failed to fetch SportMonks fixtures after retries");
}

export default async function handler(req, res) {
  const { date } = req.query;
  console.log("ENV KEYS:", {
    SPORTMONKS_KEY: !!process.env.SPORTMONKS_KEY,
    ODDS_API_KEY: !!process.env.ODDS_API_KEY,
  });
  if (!date) return res.status(400).json({ error: "missing date query param" });

  try {
    const raw = await fetchSportmonksFixturesWithRetry(date);
    const all = raw.data || [];
    const fixtures = all.filter((f) => f.time?.status === "NS");

    const picks = fixtures.map((f) => ({
      fixture_id: f.id,
      league: { id: f.league.data.id, name: f.league.data.name },
      teams: {
        home: { id: f.localTeam.data.id, name: f.localTeam.data.name },
        away: { id: f.visitorTeam.data.id, name: f.visitorTeam.data.name },
      },
      datetime_local: f.time,
      model_probs: { home: 0.45, draw: 0.25, away: 0.3 },
      predicted: "home",
      confidence: 30,
      rankScore: 30,
      btts_probability: 0.4,
      over25_probability: 0.32,
    }));

    res.status(200).json({ picks, debug: { total_fetched: fixtures.length } });
  } catch (err) {
    console.error("/api/select-matches error:", err);
    res.status(200).json({ picks: [], debug: { error: err.message } });
  }
}
