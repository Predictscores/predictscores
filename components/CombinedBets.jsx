// components/CombinedBets.jsx
import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

/** Combined: 3 top fudbal + 3 top kripto. Bez desnog panela, bez tiketa. */
export default function CombinedBets() {
  return (
    <Tabs>
      <div label="Combined">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <FootballBets layout="combined" />
          </div>
          <div className="md:col-span-1">
            <CryptoTopSignals limit={3} />
          </div>
        </div>
      </div>

      <div label="Football">
        <FootballBets layout="full" />
      </div>

      <div label="Crypto">
        <CryptoTopSignals limit={10} />
      </div>
    </Tabs>
  );
}
