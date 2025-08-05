// FILE: hooks/useValueBets.js

import { useState, useEffect } from 'react';

/**
 * sortValueBets: MODEL+ODDS prvo, po edge, pa po model_prob
 */
function sortValueBets(bets = []) {
  return bets
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'MODEL+ODDS' ? -1 : 1;
      }
      const eA = a.edge ?? 0;
      const eB = b.edge ?? 0;
      if (eB !== eA) {
        return eB - eA;
      }
      return (b.model_prob ?? 0) - (a.model_prob ?? 0);
    });
}

/**
 * useValueBets hook:
 * - date: string "YYYY-MM-DD"
 * - vraća { bets, loading, error }
 * - automatski refrešuje svakih 2h
 */
export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;

    const fetchBets = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/value-bets?sport_key=soccer&date=${encodeURIComponent(
            date
          )}&min_edge=0.05&min_odds=1.3`
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const json = await res.json();
        const raw = Array.isArray(json.value_bets) ? json.value_bets : [];
        if (!cancelled) {
          setBets(sortValueBets(raw));
        }
      } catch (e) {
        console.error('useValueBets fetch error', e);
        if (!cancelled) {
          setError(e.message);
          setBets([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchBets();
    const interval = setInterval(fetchBets, 2 * 60 * 60 * 1000); // osvežavanje svakih 2h

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [date]);

  return { bets, loading, error };
}
