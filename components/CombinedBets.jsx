// FILE: components/CombinedBets.jsx
import React, { useMemo } from 'react';
import Tabs from './Tabs';
import FootballBets from './FootballBets';
import CryptoTopSignals from './CryptoTopSignals';

export default function CombinedBets() {
  // Današnji datum u formatu YYYY-MM-DD za FootballBets
  const today = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);

  return (
    <Tabs>
      <div label="Combined">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Top 3 football & Top 3 crypto */}
          <FootballBets date={today} />
          <CryptoTopSignals limit={3} />
        </div>
      </div>

      <div label="Football">
        {/* Top football suggestions for today */}
        <FootballBets date={today} />
      </div>

      <div label="Crypto">
        {/* Top crypto suggestions (već sortirano po score DESC) */}
        <CryptoTopSignals limit={10} />
      </div>
    </Tabs>
  );
}
