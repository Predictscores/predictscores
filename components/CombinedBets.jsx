// FILE: components/CombinedBets.jsx
import React from 'react';
import Tabs from './Tabs';
import FootballBets from './FootballBets';
import CryptoTopSignals from './CryptoTopSignals';

export default function CombinedBets() {
  return (
    <Tabs>
      {/* COMBINED: 1/3 football (top 3) + 2/3 crypto (top 3) */}
      <div label="Combined">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Leva kolona (1/3): tri fudbalske kartice, jedna ispod druge */}
          <div className="lg:col-span-1 space-y-4">
            <FootballBets limit={3} />
          </div>

          {/* Desna kolona (2/3): tri kripto kartice u gridu */}
          <div className="lg:col-span-2">
            <CryptoTopSignals limit={3} />
          </div>
        </div>
      </div>

      {/* FOOTBALL tab: prikaži sve (ili top 10, po tvom izboru) */}
      <div label="Football">
        <FootballBets limit={10} />
      </div>

      {/* CRYPTO tab: po želji top 10 */}
      <div label="Crypto">
        <CryptoTopSignals limit={10} />
      </div>
    </Tabs>
  );
}
