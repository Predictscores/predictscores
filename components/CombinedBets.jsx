// components/CombinedBets.jsx
import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

/**
 * Combined: levo Football (Top 3), desno Crypto (Top 3).
 * VAŽNO: za combined layout FootballBets skriva tikete i tabove.
 */
const CombinedBets = () => (
  <Tabs>
    <div label="Combined">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        <div className="md:col-span-1">
          <FootballBets limit={3} layout="combined" />
        </div>
        <div className="md:col-span-2">
          <CryptoTopSignals limit={3} />
        </div>
      </div>
    </div>

    <div label="Football">
      <FootballBets limit={25} layout="full" />
    </div>

    <div label="Crypto">
      <CryptoTopSignals limit={10} />
    </div>
  </Tabs>
);

export default CombinedBets;
