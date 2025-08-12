import { useState, useEffect } from 'react';

/**
 * useValueBets (LOCKED):
 * - date: "YYYY-MM-DD"
 * - čita /api/value-bets-locked?date=...
 * - kešira u localStorage (ključ valueBetsLocked_<date>)
 * - bez fallback-a na juče (da ne diže pozive)
 */

function sortValueBets(bets = []) {
  return bets
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'MODEL+ODDS' ? -1 : 1;
      const eA = a.edge ?? 0;
      const eB = b.edge ?? 0;
      if (eB !== eA) return eB - eA;
      return (b.model_prob ?? 0) - (a.model_prob ?? 0);
    });
}

async function fetchLockedForDate(date) {
  const res = await fetch(`/api/value-bets-locked?date=${encodeURIComponent(date)}`);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return Array.isArray(json.value_bets) ? json.value_bets : [];
}

export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!date) return;
    const cacheKey = `valueBetsLocked_${date}`;
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

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const raw = await fetchLockedForDate(date);
        const sorted = sortValueBets(raw);
        if (!cancelled) {
          setBets(sorted);
          localStorage.setItem(cacheKey, JSON.stringify(sorted));
        }
      } catch (e) {
        console.error('useValueBets (locked) error', e);
        if (!cancelled) {
          setError(e.message);
          setBets([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [date]);

  return { bets, loading, error };
}
