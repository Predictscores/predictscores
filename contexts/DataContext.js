// FILE: contexts/DataContext.js
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const DataContext = createContext({});

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error('[DataContext] fetch failed:', url, e?.message || e);
    return null;
  }
}

export default function DataProvider({ children }) {
  // ---- KRIPTO ----
  const [crypto, setCrypto] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(true);
  const [cryptoNextRefreshAt, setCryptoNextRefreshAt] = useState(null);
  const cryptoTimer = useRef(null);

  const loadCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    const json = await fetchJSON('/api/crypto');
    // format koji si pokazao: { crypto: [...] }
    const list = Array.isArray(json?.crypto) ? json.crypto : [];
    setCrypto(list);
    setLoadingCrypto(false);

    // sledeći refresh – za ~10 min
    const next = Date.now() + 10 * 60 * 1000;
    setCryptoNextRefreshAt(next);
  }, []);

  // inicijalno učitavanje + interval
  useEffect(() => {
    loadCrypto();
    cryptoTimer.current && clearInterval(cryptoTimer.current);
    cryptoTimer.current = setInterval(loadCrypto, 10 * 60 * 1000);
    return () => cryptoTimer.current && clearInterval(cryptoTimer.current);
  }, [loadCrypto]);

  // ---- FOOTBALL (opciono – samo timestamp zadnjeg generisanja) ----
  const [footballLastGenerated, setFootballLastGenerated] = useState(null);
  const [nextKickoffTs, setNextKickoffTs] = useState(null);

  const loadFootballMeta = useCallback(async () => {
    const json = await fetchJSON('/api/value-bets');
    if (json) {
      setFootballLastGenerated(Date.now());
      // probaj da izvučeš najraniji kickoff ako postoji
      try {
        const picks = Array.isArray(json.value_bets) ? json.value_bets : [];
        const times = picks
          .map(p => p?.datetime_local?.starting_at?.date_time)
          .filter(Boolean)
          .map(s => new Date(s.replace(' ', 'T')).getTime())
          .filter(t => Number.isFinite(t) && t > Date.now());
        if (times.length) setNextKickoffTs(Math.min(...times));
        else setNextKickoffTs(null);
      } catch { /* no-op */ }
    }
  }, []);

  // Nemoj preterano – učitaj jednom na mount, FootballBets radi svoje
  useEffect(() => {
    loadFootballMeta();
  }, [loadFootballMeta]);

  // ---- PUBLIC API ----
  const refreshAll = useCallback(() => {
    loadCrypto();
    loadFootballMeta();
  }, [loadCrypto, loadFootballMeta]);

  const value = useMemo(() => ({
    // crypto
    crypto,
    loadingCrypto,
    cryptoNextRefreshAt,
    // football meta
    footballLastGenerated,
    nextKickoffTs,
    // actions
    refreshAll,
  }), [
    crypto,
    loadingCrypto,
    cryptoNextRefreshAt,
    footballLastGenerated,
    nextKickoffTs,
    refreshAll,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
