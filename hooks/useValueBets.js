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

async function fetchLockedBetsForDate(date) {
  const res = await fetch(
    `/api/value-bets-locked?date=${encodeURIComponent(date)}`
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return Array.isArray(json.value_bets) ? json.value_bets : [];
}

/**
 * useValueBets hook (locked variant):
 * - date: string "YYYY-MM-DD"
 * - caches results in localStorage under key `valueBets_<date>`
 * - if empty, tries yesterday
 */
export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!date) return;
    const cacheKey = `valueBets_${date}`;
    let cancelled = false;

    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        setBets(JSON.parse(cached));
        setLoading(false);
        return;
      } catch {
        localStorage.removeItem(cacheKey);
      }
    }

    const fetchAndCache = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1) Try today (locked)
        let raw = await fetchLockedBetsForDate(date);

        // 2) If empty, try yesterday (locked)
        if (raw.length === 0) {
          const d = new Date(date);
          d.setDate(d.getDate() - 1);
          const ystr = d.toISOString().slice(0, 10);
          raw = await fetchLockedBetsForDate(ystr);
        }

        const sorted = sortValueBets(raw);
        if (!cancelled) {
          setBets(sorted);
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
    return () => {
      cancelled = true;
    };
  }, [date]);

  return { bets, loading, error };
}
