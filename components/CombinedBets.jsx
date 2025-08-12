// FILE: components/CombinedBets.jsx
import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

/**
 * Raspored:
 * - Combined: grid sa 3 kolone (md+). Levo: Football (Top 5) -> 1 kolona (≈33%).
 *             Desno: Crypto (Top 5) -> span 2 kolone (≈66%).
 * - Football tab: Top 25 (sa filterima/sortom + desni stub Tickets 3×3)
 * - Crypto tab: Top 10
 */
const CombinedBets = () => (
  <Tabs>
    <div label="Combined">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        {/* Levo: Football Top 5 (stroži filter ≥70% confidence, dopuna po EV) */}
        <div className="md:col-span-1">
          <FootballBets limit={5} layout="combined" />
        </div>

        {/* Desno: Crypto Top 5 */}
        <div className="md:col-span-2">
          <CryptoTopSignals limit={5} />
        </div>
      </div>
    </div>

    <div label="Football">
      {/* Top 25 + filteri/sort + desni stub sa Tiketima (BTTS/HT-FT/1X2 po 3) */}
      <FootballBets limit={25} layout="full" />
    </div>

    <div label="Crypto">
      <CryptoTopSignals limit={10} />
    </div>
  </Tabs>
);

export default CombinedBets;
