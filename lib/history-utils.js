// lib/history-utils.js

/**
 * Jednostavan ROI:
 * - stake = 1 po picku
 * - ako je result === "win" ili won===true → profit = (price_snapshot - 1)
 * - ako je "loss" → profit = -1
 * - ako nema rezultata → ignoriši (pending)
 */
export function computeROI(items) {
  let played = 0, wins = 0, profit = 0, avgOdds = 0;
  for (const e of (items || [])) {
    const res = (e?.result || "").toString().toLowerCase();
    const won = (e?.won === true) || /win/.test(res);
    const lost = /loss|lose/.test(res);
    const odds = Number(e?.price_snapshot) || Number(e?.odds?.price) || null;
    if (won) {
      played++;
      wins++;
      if (odds) {
        profit += (odds - 1);
        avgOdds += odds;
      } else {
        profit += 0;
      }
    } else if (lost) {
      played++;
      profit -= 1;
      if (odds) avgOdds += odds;
    }
    // pending se preskače
  }
  const roi = played ? (profit / played) : 0;
  const wr = played ? (wins / played) : 0;
  const ao = played ? (avgOdds / played) : 0;
  return { played, wins, profit, roi, winrate: wr, avg_odds: ao };
}

export default computeROI;
