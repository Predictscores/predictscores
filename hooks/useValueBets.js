// FILE: hooks/useValueBets.js
import { useEffect, useRef, useState } from "react";

/**
 * useValueBets (LOCKED only)
 * - Čita /api/value-bets-locked (nikad generator)
 * - Kešira 10 min u localStorage
 */

const LS_TTL_MS = 10 * 60 * 1000; // 10 min

export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const cacheKey = `vb_locked_${date || "today"}`;
    const now = Date.now();

    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (cached && now - cached.ts < LS_TTL_MS && Array.isArray(cached.data)) {
          setBets(cached.data);
          setLoading(false);
          return;
        }
      }
    } catch {}

    setLoading(true);
    setError(null);

    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        const res = await fetch("/api/value-bets-locked", { cache: "default", signal: ac.signal });
        if (!res.ok) throw new Error(`/api/value-bets-locked -> ${res.status}`);
        const j = await res.json();
        const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
        setBets(arr);
        try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: arr })); } catch {}
      } catch (e) {
        if (e.name !== "AbortError") {
          setError(e.message || String(e));
          setBets([]);
        }
      } finally {
        setLoading(false);
      }
    })();

    return () => ac.abort();
  }, [date]);

  return { bets, loading, error };
}
