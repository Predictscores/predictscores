// FILE: contexts/DataContext.js
import React, { createContext, useEffect, useMemo, useRef, useState } from 'react';

export const DataContext = createContext({
  crypto: [],
  footballTop: [],
  footballAll: [],
  loadingCrypto: false,
  loadingFootball: false,
  footballNextKickoff: null,      // ISO string u Europe/Belgrade
  footballLastGenerated: null,    // ISO UTC
  cryptoNextRefreshAt: null,      // Date.now() + 10min
  refreshAll: () => {},
});

export function DataProvider({ children }) {
  const [crypto, setCrypto] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [cryptoNextRefreshAt, setCryptoNextRefreshAt] = useState(null);

  const [footballAll, setFootballAll] = useState([]);
  const [footballTop, setFootballTop] = useState([]);
  const [loadingFootball, setLoadingFootball] = useState(false);
  const [footballLastGenerated, setFootballLastGenerated] = useState(null);
  const [footballNextKickoff, setFootballNextKickoff] = useState(null);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  async function fetchCrypto() {
    try {
      setLoadingCrypto(true);
      const r = await fetch('/api/crypto');
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j?.crypto) ? j.crypto : [];
      if (!mounted.current) return;
      setCrypto(list);
      // 10 min do sledećeg refresh-a
      setCryptoNextRefreshAt(Date.now() + 10 * 60 * 1000);
    } catch {
      if (!mounted.current) return;
      setCrypto([]);
      setCryptoNextRefreshAt(Date.now() + 10 * 60 * 1000);
    } finally {
      if (mounted.current) setLoadingCrypto(false);
    }
  }

  async function fetchFootball() {
    try {
      setLoadingFootball(true);
      const r = await fetch('/api/value-bets'); // bez debug param
      const j = await r.json().catch(() => ({}));
      const vb = Array.isArray(j?.value_bets) ? j.value_bets : [];
      if (!mounted.current) return;

      // sortiraj po našem _score ako postoji
      const sorted = [...vb].sort((a, b) => (b?._score ?? 0) - (a?._score ?? 0));
      setFootballAll(sorted);
      setFootballTop(sorted.slice(0, 3));
      setFootballLastGenerated(j?.generated_at || new Date().toISOString());

      // izračunaj najbliži kickoff u Europe/Belgrade iz payload-a
      const starts = sorted
        .map(x => x?.datetime_local?.starting_at?.date_time)
        .filter(Boolean)
        .map(dt => new Date(dt.replace(' ', 'T') + 'Z').getTime())
        .filter(t => t > Date.now())
        .sort((a, b) => a - b);
      setFootballNextKickoff(starts[0] ? new Date(starts[0]).toISOString() : null);
    } catch {
      if (!mounted.current) return;
      setFootballAll([]);
      setFootballTop([]);
      setFootballLastGenerated(new Date().toISOString());
      setFootballNextKickoff(null);
    } finally {
      if (mounted.current) setLoadingFootball(false);
    }
  }

  async function refreshAll() {
    await Promise.allSettled([fetchCrypto(), fetchFootball()]);
  }

  useEffect(() => {
    refreshAll();
    // lagani auto-refresh crypto na 10 min
    const id = setInterval(() => fetchCrypto(), 10 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const value = useMemo(() => ({
    crypto,
    footballTop,
    footballAll,
    loadingCrypto,
    loadingFootball,
    footballNextKickoff,
    footballLastGenerated,
    cryptoNextRefreshAt,
    refreshAll,
  }), [
    crypto, footballTop, footballAll,
    loadingCrypto, loadingFootball,
    footballNextKickoff, footballLastGenerated,
    cryptoNextRefreshAt,
  ]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export default DataProvider;
