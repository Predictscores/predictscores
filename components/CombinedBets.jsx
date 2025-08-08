// FILE: components/CombinedBets.jsx
import React, { useMemo } from 'react';
import Tabs from './Tabs';
import FootballBets from './FootballBets';
import CryptoTopSignals from './CryptoTopSignals';

function FootballPlaceholder() {
  return (
    <div className="w-full bg-[#1f2339] p-5 rounded-2xl shadow flex items-center justify-center min-h-[260px]">
      <span className="text-slate-300">Nema dostupne fudbalske prognoze</span>
    </div>
  );
}

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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Levo placeholder (kao pre), desno kripto top */}
          <FootballPlaceholder />
          <CryptoTopSignals limit={3} />
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
