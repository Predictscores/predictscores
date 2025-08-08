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

      // Normalizacija izlaza — podržava više formata:
      // 1) { long:[], short:[] }
      // 2) { signals:[...] }  sa signal === 'LONG'/'SHORT'
      // 3) { crypto:[...] }   (trenutni tvoj API)
      let long = [];
      let short = [];

      if (Array.isArray(json.long) || Array.isArray(json.short)) {
        long = Array.isArray(json.long) ? json.long : [];
        short = Array.isArray(json.short) ? json.short : [];
      } else if (Array.isArray(json.signals)) {
        long = json.signals.filter((s) => s.signal === 'LONG');
        short = json.signals.filter((s) => s.signal === 'SHORT');
      } else if (Array.isArray(json.crypto)) {
        long = json.crypto.filter((s) => s.signal === 'LONG');
        short = json.crypto.filter((s) => s.signal === 'SHORT');
      }

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

  // Spajanje i sortiranje po confidence DESC
  const crypto = useMemo(() => {
    const L = (longSignals || []).map((s) => ({ ...s, side: 'LONG' }));
    const S = (shortSignals || []).map((s) => ({ ...s, side: 'SHORT' }));
    return [...L, ...S].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  }, [longSignals, shortSignals]);

  const refreshCrypto = useCallback(() => fetchCrypto(), [fetchCrypto]);
  const refreshAll = useCallback(() => { fetchCrypto(); }, [fetchCrypto]);

  return (
    <DataContext.Provider
      value={{
        longSignals,
        shortSignals,
        crypto,
        loadingCrypto,
        cryptoError,
        nextCryptoUpdate,
        refreshCrypto,
        refreshAll
      }}
    >
      {children}
    </DataContext.Provider>
  );
}
