// FILE: contexts/DataContext.js
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

const initialState = {
  crypto: [],
  football: [],
  loadingCrypto: false,
  loadingFootball: false,
  nextCryptoUpdate: null,     // timestamp (ms)
  nextKickoffAt: null,        // ISO string
  footballLastGeneratedAt: null,
  cryptoLastGeneratedAt: null,
  refreshAll: () => {},
};

export const DataContext = createContext(initialState);

// --- helpers
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function parseFootballStartISO(item) {
  // pokušaj nekoliko oblika koje smo viđali
  try {
    const a = item?.datetime_local;
    if (a?.starting_at?.date_time) {
      // "2025-08-10 16:00:00" (lokalno) -> tretiramo kao lokalni string bez Z
      return a.starting_at.date_time.replace(" ", "T");
    }
    if (a?.date_time) return a.date_time.replace(" ", "T");
    const b = item?.time?.starting_at?.date_time;
    if (b) return b.replace(" ", "T");
  } catch (_) {}
  return null;
}

function computeNextKickoffISO(valueBets = []) {
  const now = Date.now();
  let best = null;
  for (const v of valueBets) {
    const iso = parseFootballStartISO(v);
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t) && t - now > 0) {
      if (!best || t < best) best = t;
    }
  }
  return best ? new Date(best).toISOString() : null;
}

function msFromNow(minutes) {
  return Date.now() + minutes * 60_000;
}

export function DataProvider({ children }) {
  const [crypto, setCrypto] = useState([]);
  const [football, setFootball] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [loadingFootball, setLoadingFootball] = useState(false);

  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null); // ms
  const [nextKickoffAt, setNextKickoffAt] = useState(null);       // ISO
  const [footballLastGeneratedAt, setFootballLastGeneratedAt] = useState(null);
  const [cryptoLastGeneratedAt, setCryptoLastGeneratedAt] = useState(null);

  // anti–spam throttle za "Refresh all"
  const lastRefreshRef = useRef(0);

  const loadCrypto = useCallback(async () => {
    setLoadingCrypto(true);
    try {
      const data = await fetchJson("/api/crypto");
      const list = Array.isArray(data?.crypto) ? data.crypto : [];
      setCrypto(list);
      setCryptoLastGeneratedAt(new Date().toISOString());
      // sledeći refresh za ~10 minuta (možeš da promeniš interval)
      setNextCryptoUpdate(msFromNow(10));
    } catch (e) {
      // ne ruši UI
      console.warn("loadCrypto error:", e?.message || e);
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  const loadFootball = useCallback(async () => {
    setLoadingFootball(true);
    try {
      const data = await fetchJson("/api/value-bets");
      const bets = Array.isArray(data?.value_bets) ? data.value_bets : [];
      setFootball(bets);
      setFootballLastGeneratedAt(
        data?.generated_at ? new Date(data.generated_at).toISOString() : new Date().toISOString()
      );
      setNextKickoffAt(computeNextKickoffISO(bets));
    } catch (e) {
      console.warn("loadFootball error:", e?.message || e);
    } finally {
      setLoadingFootball(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    const now = Date.now();
    if (now - lastRefreshRef.current < 5_000) return; // 5s throttle
    lastRefreshRef.current = now;
    await Promise.allSettled([loadCrypto(), loadFootball()]);
  }, [loadCrypto, loadFootball]);

  // prvi load na klijentu
  useEffect(() => {
    // samo na klijentu (Next SSR zaštita)
    if (typeof window === "undefined") return;
    refreshAll();
  }, [refreshAll]);

  // jeftin "tajmer" da se crypto auto osveži kada istekne nextCryptoUpdate
  useEffect(() => {
    if (!nextCryptoUpdate) return;
    const id = setInterval(() => {
      const now = Date.now();
      if (now >= nextCryptoUpdate) {
        loadCrypto(); // osveži i postavi sledeći
      }
    }, 1000);
    return () => clearInterval(id);
  }, [nextCryptoUpdate, loadCrypto]);

  const value = useMemo(
    () => ({
      crypto,
      football,
      loadingCrypto,
      loadingFootball,
      nextCryptoUpdate,
      nextKickoffAt,
      footballLastGeneratedAt,
      cryptoLastGeneratedAt,
      refreshAll,
    }),
    [
      crypto,
      football,
      loadingCrypto,
      loadingFootball,
      nextCryptoUpdate,
      nextKickoffAt,
      footballLastGeneratedAt,
      cryptoLastGeneratedAt,
      refreshAll,
    ]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

// kompatibilnost: i default i named export-i
export default DataProvider;

// user friendly hook (zbog starog koda koji ga očekuje)
export function useData() {
  const ctx = React.useContext(DataContext);
  return ctx || initialState;
}
