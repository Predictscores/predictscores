import React from "react";
import Tabs from "./Tabs";
import FootballBets from "./FootballBets";
import CryptoTopSignals from "./CryptoTopSignals";

const CombinedBets = () => (
  <Tabs>
    <div label="Combined">
      {/* 33% / 66% raspored */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4 items-stretch">
        {/* Leva kolona – fudbal (top 3) */}
        <div className="flex flex-col gap-4">
          <FootballBets limit={3} tall />
        </div>
        {/* Desna kolona – kripto (top 3) */}
        <div className="flex flex-col gap-4">
          <CryptoTopSignals limit={3} />
        </div>
      </div>
    </div>

    <div label="Football">
      {/* Ovde puni spisak, bez limit-a */}
      <FootballBets tall />
    </div>

    <div label="Crypto">
      <CryptoTopSignals limit={10} />
    </div>
  </Tabs>
);

export default CombinedBets;
