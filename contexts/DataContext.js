// FILE: contexts/DataContext.js
import { createContext, useState, useEffect, useCallback } from 'react';

export const DataContext = createContext();

export function DataProvider({ children }) {
  const [longSignals, setLongSignals]   = useState([]);
  const [shortSignals, setShortSignals] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);

  const fetchCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    try {
      const res = await fetch('/api/crypto');
      if (!res.ok) throw new Error('Fetch crypto failed');
      const { long, short } = await res.json();
      setLongSignals(long);
      setShortSignals(short);
      setNextCryptoUpdate(Date.now() + 10 * 60 * 1000);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  useEffect(() => {
    fetchCrypto();
    const iv = setInterval(fetchCrypto, 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, [fetchCrypto]);

  const refreshAll = () => {
    fetchCrypto();
    // … football if needed
  };

  return (
    <DataContext.Provider
      value={{
        longSignals,
        shortSignals,
        loadingCrypto,
        nextCryptoUpdate,
        refreshAll
      }}
    >
      {children}
    </DataContext.Provider>
  );
}
