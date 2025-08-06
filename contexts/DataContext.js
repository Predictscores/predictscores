// contexts/DataContext.js
import React, { createContext, useState, useEffect, useCallback } from 'react';

export const DataContext = createContext();

export function DataProvider({ children }) {
  // Crypto state
  const [cryptoData, setCryptoData] = useState({ cryptoTop: [], combined: [] });
  const [loadingCrypto, setLoadingCrypto] = useState(true);
  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);

  // Football state (pretpostavljam da već imaš fetching, prilagodio sam strukturu)
  const [footballData, setFootballData] = useState({ footballTop: [], generated_at: null });
  const [loadingFootball, setLoadingFootball] = useState(true);

  // Fetch crypto signals
  const fetchCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    try {
      const res = await fetch('/api/crypto');
      const json = await res.json();
      setCryptoData({
        cryptoTop: json.crypto,      // za Crypto tab
        combined: json.combined      // za Combined sekciju
      });
      // zakaži sledeće osveženje
      setNextCryptoUpdate(Date.now() + 10 * 60 * 1000);
    } catch (err) {
      console.error('Crypto fetch error:', err);
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  // Fetch football predictions
  const fetchFootball = useCallback(async () => {
    setLoadingFootball(true);
    try {
      const res = await fetch('/api/football');
      const json = await res.json();
      // Pretpostavka: API vraća { top: [...], generated_at: timestamp }
      setFootballData({
        footballTop: json.top || [],
        generated_at: json.generated_at || Date.now()
      });
    } catch (err) {
      console.error('Football fetch error:', err);
    } finally {
      setLoadingFootball(false);
    }
  }, []);

  // Auto-refresh crypto na 10 minuta
  useEffect(() => {
    fetchCrypto();
    const iv = setInterval(fetchCrypto, 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, [fetchCrypto]);

  // Auto-refresh football (po potrebi – izmeni interval ako treba)
  useEffect(() => {
    fetchFootball();
    const iv2 = setInterval(fetchFootball, 10 * 60 * 1000);
    return () => clearInterval(iv2);
  }, [fetchFootball]);

  // Ručni refresh za oba
  const refreshAll = () => {
    fetchCrypto();
    fetchFootball();
  };

  return (
    <DataContext.Provider value={{
      cryptoData,
      footballData,
      loadingCrypto,
      loadingFootball,
      nextCryptoUpdate,
      refreshAll
    }}>
      {children}
    </DataContext.Provider>
  );
}
