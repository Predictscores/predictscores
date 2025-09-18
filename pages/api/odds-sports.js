// FILE: pages/api/odds-sports.js
// Ulaz (query): ?home=Team+Name&away=Team+Name&ts=YYYY-MM-DDTHH:mm:ssZ
// Izlaz: { bookmakers: [ { name, bets: [ { name: "1X2", values: [ {value:"HOME|DRAW|AWAY", odd:<decimal>} ] } ] } ] }

import { fetchOddsSnapshot } from "../../lib/sources/theOddsApi";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (!process.env.ODDS_API_KEY) {
    return res.status(500).json({ error: "Missing ODDS_API_KEY in env" });
  }

  const homeQ = String(req.query.home || "").trim();
  const awayQ = String(req.query.away || "").trim();
  const tsQ = String(req.query.ts || "").trim(); // kickoff ISO

  if (!homeQ || !awayQ || !tsQ) {
    return res
      .status(400)
      .json({ error: "Missing query: home, away, ts are required" });
  }

  // Minimalan skup popularnih liga (možeš dodati još po potrebi)
  const SOCCER_KEYS = [
    "soccer_epl",
    "soccer_uefa_champs_league",
    "soccer_spain_la_liga",
    "soccer_italy_serie_a",
    "soccer_germany_bundesliga",
    "soccer_france_ligue_one",
    "soccer_netherlands_eredivisie",
    "soccer_portugal_primeira_liga",
    "soccer_turkey_super_league",
    "soccer_uefa_europa_league",
    "soccer_uefa_europa_conference_league",
  ];

  // Normalizacija imena timova
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const HN = norm(homeQ);
  const AN = norm(awayQ);

  const kickoffTs = Date.parse(tsQ);
  if (!Number.isFinite(kickoffTs)) {
    return res.status(400).json({ error: "ts must be ISO datetime" });
  }

  // helper: u okviru +/- 2h
  const isSameEventTime = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    const diffMin = Math.abs(t - kickoffTs) / 60000;
    return diffMin <= 120;
  };

  // Pokušaćemo ligu po ligu dok ne nađemo odgovarajući event
  let matchedEvent = null;
  let budgetExhausted = false;

  for (const sport of SOCCER_KEYS) {
    try {
      const snapshot = await fetchOddsSnapshot(sport, {
        regions: "eu",
        markets: "h2h",
      });

      if (snapshot?.exhausted) {
        budgetExhausted = true;
        break;
      }

      const events = Array.isArray(snapshot?.data) ? snapshot.data : [];

      // events: [{ id, home_team, away_team, commence_time, bookmakers:[{title, markets:[{key:"h2h", outcomes:[{name, price}]}]}] }]
      for (const ev of events) {
        const evHome = norm(ev?.home_team);
        const evAway = norm(ev?.away_team);
        const isTeams =
          (evHome === HN && evAway === AN) ||
          (evHome === AN && evAway === HN); // ako je unakrsno

        if (!isTeams) continue;
        if (!isSameEventTime(ev?.commence_time)) continue;

        matchedEvent = ev;
        break;
      }

      if (matchedEvent) break;
    } catch (err) {
      // preskoči grešku i nastavi na sledeći sport
      console.error("odds-sports fetch error", err?.message || err);
    }
  }

  if (!matchedEvent) {
    if (budgetExhausted) {
      return res.status(200).json({
        bookmakers: [],
        message: "Daily odds API budget exhausted",
      });
    }

    return res.status(200).json({ bookmakers: [] });
  }

  // Mapiranje u format koji očekuje generator:
  // bookmakers[].bets[].values[] sa value: "HOME|DRAW|AWAY", odd: <decimal>
  const mapBookmakers = [];

  for (const bk of matchedEvent.bookmakers || []) {
    const markets = Array.isArray(bk?.markets) ? bk.markets : [];
    const h2h = markets.find(
      (m) => String(m?.key || "").toLowerCase() === "h2h"
    );
    if (!h2h || !Array.isArray(h2h?.outcomes)) continue;

    // Nađi kvote za home/draw/away
    let homeOdd = null,
      drawOdd = null,
      awayOdd = null;
    for (const o of h2h.outcomes) {
      const nameN = norm(o?.name);
      if (nameN === HN) homeOdd = Number(o?.price);
      else if (nameN === AN) awayOdd = Number(o?.price);
      else if (nameN === "draw") drawOdd = Number(o?.price);
    }

    const values = [];
    if (Number.isFinite(homeOdd)) values.push({ value: "HOME", odd: homeOdd });
    if (Number.isFinite(drawOdd)) values.push({ value: "DRAW", odd: drawOdd });
    if (Number.isFinite(awayOdd)) values.push({ value: "AWAY", odd: awayOdd });

    if (values.length) {
      mapBookmakers.push({
        name: bk?.title || "bookmaker",
        bets: [{ name: "1X2", values }],
      });
    }
  }

  return res.status(200).json({ bookmakers: mapBookmakers });
}
