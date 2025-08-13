// FILE: hooks/useValueBets.js
import { useEffect, useRef, useState } from "react";

/**
 * useValueBets (UNLOCKED)
 * - čita /api/value-bets umesto zaključane rute
 * - lokalni cache preko localStorage da čuva budžet poziva (TTL 10 min)
 * - vraća { bets, loading, error }
 */

const LS_TTL_MS = 10 * 60 * 1000; // 10 min

function sortValueBets(bets = []) {
  return bets
    .slice()
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "MODEL+ODDS" ? -1 : 1;
      const eA = a.edge ?? 0;
      const eB = b.edge ?? 0;
      if (eB !== eA) return eB - eA;
      return (b.model_prob ?? 0) - (a.model_prob ?? 0);
    });
}

export default function useValueBets(date) {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    // ključ po danu da cache ne traje preko sutrašnjeg dana
    const cacheKey = `valueBets_unlocked_${date || "today"}`;
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
    } catch {
      /* ignore */
    }

    setLoading(true);
    setError(null);

    // abort prethodnog fetcha ako postoji
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    (async () => {
      try {
        // VAŽNO: koristimo UNLOCKED endpoint
        const res = await fetch("/api/value-bets", {
          // koristimo default GET + CDN keš (server već ima s-maxage)
          cache: "default",
          signal: ac.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`/api/value-bets -> ${res.status} ${txt?.slice(0, 120)}`);
        }
        const j = await res.json();
        const arr = Array.isArray(j?.value_bets) ? j.value_bets : [];
        const sorted = sortValueBets(arr);
        setBets(sorted);
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: sorted }));
        } catch {}
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
