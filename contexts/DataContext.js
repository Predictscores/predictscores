// FILE: contexts/DataContext.js
import { createContext, useState, useEffect, useCallback } from 'react';

export const DataContext = createContext();

export function DataProvider({ children }) {
  const [footballData, setFootballData] = useState({ picks: [], date: null, generated_at: null });
  const [cryptoData, setCryptoData] = useState({ cryptoTop: [], generated_at: null });
  const [loadingFootball, setLoadingFootball] = useState(false);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().slice(0, 10)
  );

  // Fallback fetch: za datum i narednih maxDays dana
  const fetchWithFallback = useCallback(async (startDate, maxDays = 7) => {
    for (let i = 0; i < maxDays; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);
      const res = await fetch(`/api/select-matches?date=${dateStr}`);
      const json = await res.json();
      if (json.picks && json.picks.length > 0) {
        return { picks: json.picks, date: dateStr };
      }
    }
    return { picks: [], date: null };
  }, []);

  const loadFootball = useCallback(async () => {
    setLoadingFootball(true);
    try {
      const { picks, date } = await fetchWithFallback(selectedDate, 7);
      setFootballData({
        picks,
        date,
        generated_at: Date.now(),
      });
    } catch (e) {
      console.error('Error fetching football picks:', e);
      setFootballData({ picks: [], date: null, generated_at: Date.now() });
    } finally {
      setLoadingFootball(false);
    }
  }, [fetchWithFallback, selectedDate]);

  // (Crypto loader ostaje kako je bio)
  const loadCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    try {
      // ... tvoja postojeća logika za cryptoData
      setCryptoData({
        cryptoTop: [], // primer
        generated_at: Date.now(),
      });
    } catch {
      setCryptoData({ cryptoTop: [], generated_at: Date.now() });
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  // Ucitaj oba na startu i kad se klikne Refresh
  const refreshAll = () => {
    loadFootball();
    loadCrypto();
  };

  useEffect(() => {
    refreshAll();
  }, [selectedDate]);

  return (
    <DataContext.Provider
      value={{
        footballData,
        cryptoData,
        loadingFootball,
        loadingCrypto,
        refreshAll,
        selectedDate,
        setSelectedDate,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}
