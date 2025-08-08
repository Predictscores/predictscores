// FILE: contexts/DataContext.js
import { createContext, useState, useEffect, useCallback, useMemo } from 'react';

export const DataContext = createContext();

export function DataProvider({ children }) {
  const [longSignals, setLongSignals] = useState([]);
  const [shortSignals, setShortSignals] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [cryptoError, setCryptoError] = useState(null);
  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);

  const fetchCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    setCryptoError(null);
    try {
      const res = await fetch('/api/crypto', { headers: { accept: 'application/json' } });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('application/json')) {
        throw new Error(`Crypto API bad response: status ${res.status}`);
      }
      const json = await res.json();

      // Normalizacija: podrži i {long, short} i {signals}
      const long = Array.isArray(json.long)
        ? json.long
        : Array.isArray(json.signals)
        ? json.signals.filter((s) => s.signal === 'LONG')
        : [];

      const short = Array.isArray(json.short)
        ? json.short
        : Array.isArray(json.signals)
        ? json.signals.filter((s) => s.signal === 'SHORT')
        : [];

      setLongSignals(long);
      setShortSignals(short);
      setNextCryptoUpdate(Date.now() + 10 * 60 * 1000); // 10 min
    } catch (e) {
      console.error('fetchCrypto error', e);
      setLongSignals([]);
      setShortSignals([]);
      setCryptoError(e.message || 'Error');
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  useEffect(() => {
    fetchCrypto();
    const iv = setInterval(fetchCrypto, 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, [fetchCrypto]);

  // Spajanje u jedan niz, sort po confidence desc
  const crypto = useMemo(() => {
    const L = (longSignals || []).map((s) => ({ ...s, side: 'LONG' }));
    const S = (shortSignals || []).map((s) => ({ ...s, side: 'SHORT' }));
    return [...L, ...S].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }, [longSignals, shortSignals]);

  const refreshCrypto = useCallback(() => fetchCrypto(), [fetchCrypto]);

  const refreshAll = useCallback(() => {
    fetchCrypto();
    // ovde ćemo dodati football refresh kad pređemo na fudbal
  }, [fetchCrypto]);

  return (
    <DataContext.Provider
      value={{
        // raw
        longSignals,
        shortSignals,
        // combined
        crypto,
        // state
        loadingCrypto,
        cryptoError,
        nextCryptoUpdate,
        // actions
        refreshCrypto,
        refreshAll,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}
