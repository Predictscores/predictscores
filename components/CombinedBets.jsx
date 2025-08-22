// components/CombinedBets.jsx
import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

/**
 * Combined: levo Top 3 FOOTBALL, desno Top 3 CRYPTO.
 * NEMA tiketa u Combined.
 */
export default function CombinedBets() {
  return (
    <Tabs>
      <div label="Combined">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
          <div className="md:col-span-2">
            {/* Football — samo Top N kartica, bez tabova i side panela */}
            <FootballBets limit={3} layout="combined" />
          </div>
          <div className="md:col-span-1">
            <CryptoTopSignals limit={3} />
          </div>
        </div>
      </div>

      <div label="Football">
        {/* Full football tab (tabovi + side panel), bez tiketa */}
        <FootballBets limit={50} layout="full" />
      </div>

      <div label="Crypto">
        <CryptoTopSignals limit={12} />
      </div>
    </Tabs>
  );
}
