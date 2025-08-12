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
  try {
    const a = item?.datetime_local;
    if (a?.starting_at?.date_time) return a.starting_at.date_time.replace(" ", "T");
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
      setNextCryptoUpdate(msFromNow(10)); // ~10 min
    } catch (e) {
      console.warn("loadCrypto error:", e?.message || e);
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  const loadFootball = useCallback(async () => {
    setLoadingFootball(true);
    try {
      // KORISTI LOCKED ENDPOINT
      const data = await fetchJson("/api/value-bets-locked");
      const bets = Array.isArray(data?.value_bets) ? data.value_bets : [];
      setFootball(bets);
      // built_at ili generated_at ako postoji
      const builtAt = data?.built_at || data?.generated_at || new Date().toISOString();
      setFootballLastGeneratedAt(new Date(builtAt).toISOString());
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

export default DataProvider;

export function useData() {
  const ctx = React.useContext(DataContext);
  return ctx || initialState;
}
