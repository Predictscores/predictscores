import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

const CombinedBets = () => (
  <Tabs>
    <div label="Combined">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Levo: top 3 football */}
        <FootballBets limit={3} />
        {/* Desno: top 3 crypto */}
        <CryptoTopSignals limit={3} />
      </div>
    </div>

    <div label="Football">
      {/* Top 10 football (ili koliko god vrati – bez ograničenja ovde) */}
      <FootballBets />
    </div>

    <div label="Crypto">
      {/* Top 10 crypto */}
      <CryptoTopSignals limit={10} />
    </div>
  </Tabs>
);

export default CombinedBets;
