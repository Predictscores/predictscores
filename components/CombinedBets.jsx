import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

/**
 * Raspored:
 * - Combined: grid sa 3 kolone (md+). Levo: Football (Top 3) -> 1 kolona (≈33%).
 *             Desno: Crypto (Top 3) -> span 2 kolone (≈66%).
 * - Football tab: Top 25 (LOCKED)
 * - Crypto tab: Top 10
 *
 * Napomena: Combined sada bira Top 3 po CONFIDENCE (EV samo kao tie-break).
 */
const CombinedBets = () => (
  <Tabs>
    <div label="Combined">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        {/* Levo: Football Top 3, u "combined" layoutu, kartice iste visine */}
        <div className="md:col-span-1">
          <FootballBets limit={3} layout="combined" />
        </div>

        {/* Desno: Crypto Top 3, širi prostor */}
        <div className="md:col-span-2">
          <CryptoTopSignals limit={3} />
        </div>
      </div>
    </div>

    <div label="Football">
      {/* LOCKED lista — prikaži do 25 */}
      <FootballBets limit={25} layout="full" />
    </div>

    <div label="Crypto">
      <CryptoTopSignals limit={10} />
    </div>
  </Tabs>
);

export default CombinedBets;
