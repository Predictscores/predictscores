// FILE: components/CombinedBets.jsx
import React, { useEffect, useMemo, useState } from 'react';
import Tabs from './Tabs';
import FootballBets from './FootballBets';
import CryptoTopSignals from './CryptoTopSignals';

export default function CombinedBets() {
  const today = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }, []);

  // Proveri da li uopšte ima fudbalskih tipova za danas; ako nema → Crypto neka bude 100% širine
  const [hasFootball, setHasFootball] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function checkFootball() {
      try {
        const url = '/api/value-bets?sport_key=soccer&date=' + encodeURIComponent(today) + '&min_edge=0.05&min_odds=1.3';
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const list = Array.isArray(json && json.value_bets) ? json.value_bets : [];
        if (!cancelled) setHasFootball(list.length > 0);
      } catch (e) {
        if (!cancelled) setHasFootball(false);
      }
    }
    checkFootball();
    return function () { cancelled = true; };
  }, [today]);

  return (
    <Tabs>
      <div label="Combined">
        {/* Ako nema fudbala, Crypto zauzima celu širinu */}
        {hasFootball ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FootballBets date={today} />
            <CryptoTopSignals limit={3} />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            <CryptoTopSignals limit={10} />
          </div>
        )}
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
