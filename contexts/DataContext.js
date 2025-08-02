// contexts/DataContext.js
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const DataContext = createContext(null);

export function useData() {
  return useContext(DataContext);
}

export function DataProvider({ children }) {
  const [cryptoData, setCryptoData] = useState(null);
  const [footballData, setFootballData] = useState(null);
  const [loadingCrypto, setLoadingCrypto] = useState(true);
  const [loadingFootball, setLoadingFootball] = useState(true);
  const [errorCrypto, setErrorCrypto] = useState(null);
  const [errorFootball, setErrorFootball] = useState(null);

  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);
  const [nextFootballUpdate, setNextFootballUpdate] = useState(null);

  const CRYPTO_INTERVAL = 10 * 60 * 1000; // 10m
  const FOOTBALL_INTERVAL = 30 * 60 * 1000; // 30m

  const fetchCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    setErrorCrypto(null);
    try {
      const res = await fetch('/api/crypto');
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} - ${txt}`);
      }
      const d = await res.json();
      setCryptoData(d);
      setNextCryptoUpdate(Date.now() + CRYPTO_INTERVAL);
    } catch (e) {
      setErrorCrypto(e.message);
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  const fetchFootball = useCallback(async () => {
    setLoadingFootball(true);
    setErrorFootball(null);
    try {
      const res = await fetch('/api/football');
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status} - ${txt}`);
      }
      const d = await res.json();
      setFootballData(d);
      setNextFootballUpdate(Date.now() + FOOTBALL_INTERVAL);
    } catch (e) {
      setErrorFootball(e.message);
    } finally {
      setLoadingFootball(false);
    }
  }, []);

  useEffect(() => {
    fetchCrypto();
    fetchFootball();
    const ivCrypto = setInterval(fetchCrypto, CRYPTO_INTERVAL);
    const ivFootball = setInterval(fetchFootball, FOOTBALL_INTERVAL);
    return () => {
      clearInterval(ivCrypto);
      clearInterval(ivFootball);
    };
  }, [fetchCrypto, fetchFootball]);

  const value = {
    cryptoData,
    footballData,
    loadingCrypto,
    loadingFootball,
    errorCrypto,
    errorFootball,
    refreshCrypto: fetchCrypto,
    refreshFootball: fetchFootball,
    refreshAll: () => {
      fetchCrypto();
      fetchFootball();
    },
    nextCryptoUpdate,
    nextFootballUpdate,
  };

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
