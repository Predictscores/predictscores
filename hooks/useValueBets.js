// FILE: hooks/useValueBets.js
import { useEffect, useRef, useState } from "react";

/**
 * Čita /api/value-bets (ne zaključanu rutu).
 * Parametar `date` je opciono informativan (endpoint koristi rolling window).
 * Vraća: { bets, loading, error }
 */
export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    // prekini prethodni fetch ako postoji
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        // važna stvar: koristimo /api/value-bets
        const res = await fetch("/api/value-bets", {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!res.ok) {
          throw new Error(`/api/value-bets -> ${res.status}`);
        }
        const json = await res.json();
        const arr = Array.isArray(json?.value_bets) ? json.value_bets : [];
        setBets(arr);
      } catch (e) {
        if (e.name !== "AbortError") setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      ac.abort();
    };
  }, [date]); // refetch kad se promeni dan

  return { bets, loading, error };
}
