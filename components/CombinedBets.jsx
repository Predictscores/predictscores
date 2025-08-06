// components/CombinedBets.jsx
import React from 'react';
import Tabs from './Tabs';
import FootballBets from './FootballBets';
import CryptoTopSignals from './CryptoTopSignals';

const CombinedBets = () => (
  <Tabs>
    <div label="Combined">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top 3 football & Top 3 crypto */}
        <FootballBets limit={3} />
        <CryptoTopSignals limit={3} />
      </div>
    </div>
    <div label="Football">
      {/* Top 10 football */}
      <FootballBets limit={10} />
    </div>
    <div label="Crypto">
      {/* Top 10 crypto */}
      <CryptoTopSignals limit={10} />
    </div>
  </Tabs>
);

export default CombinedBets;
