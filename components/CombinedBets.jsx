// FILE: components/CombinedBets.jsx
import React, { useMemo } from 'react';
import Tabs from './Tabs';
import FootballBets from './FootballBets';
import CryptoTopSignals from './CryptoTopSignals';

export default function CombinedBets() {
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
        {/* 1/3 : 2/3 raspored i na desktopu */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          <div className="md:col-span-4">
            {/* Top 3 football, kompaktan tamni stil */}
            <FootballBets date={today} limit={3} compact />
          </div>
          <div className="md:col-span-8">
            {/* Top 3 crypto (već sortirano po score DESC) */}
            <CryptoTopSignals limit={3} />
          </div>
        </div>
      </div>

      <div label="Football">
        <FootballBets date={today} />
      </div>

      <div label="Crypto">
        <CryptoTopSignals limit={10} />
      </div>
    </Tabs>
  );
}
