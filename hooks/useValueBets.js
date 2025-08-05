// FILE: hooks/useValueBets.js

import { useState, useEffect } from 'react';

/**
 * sortValueBets: MODEL+ODDS first, then by edge, then by model_prob
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
 * - caches results in localStorage under key `valueBets_<date>`
 * - auto-refreshes once per day (at first use for new date)
 */
export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!date) return;
    const cacheKey = `valueBets_${date}`;
    let cancelled = false;

    // Try reading from cache
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setBets(parsed);
        setLoading(false);
      } catch (e) {
        // invalid JSON, clear cache
        localStorage.removeItem(cacheKey);
      }
    }

    // If no cached data, fetch and cache
    if (!cached) {
      const fetchAndCache = async () => {
        setLoading(true);
        setError(null);
        try {
          const res = await fetch(
            `/api/value-bets?sport_key=soccer&date=${encodeURIComponent(
              date
            )}&min_edge=0.05&min_odds=1.3`
          );
          if (!res.ok) {
            const txt = await res.text();
            throw new Error(`HTTP ${res.status}: ${txt}`);
          }
          const json = await res.json();
          const raw = Array.isArray(json.value_bets) ? json.value_bets : [];
          const sorted = sortValueBets(raw);
          if (!cancelled) {
            setBets(sorted);
            // Cache the sorted results for this date
            localStorage.setItem(cacheKey, JSON.stringify(sorted));
          }
        } catch (e) {
          console.error('useValueBets fetch error', e);
          if (!cancelled) {
            setError(e.message);
            setBets([]);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      };
      fetchAndCache();
    }

    return () => {
      cancelled = true;
    };
  }, [date]);

  return { bets, loading, error };
}
