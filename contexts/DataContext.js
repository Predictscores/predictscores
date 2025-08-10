// contexts/DataContext.js
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

export const DataContext = createContext({
  // crypto
  crypto: [],
  loadingCrypto: false,
  nextCryptoUpdate: null,

  // football
  football: [],
  loadingFootball: false,
  footballLastGenerated: null,
  nextKickoffTs: null,

  // actions
  refreshAll: () => {},
});

function nowTs() {
  return Date.now();
}

function tsFromISO(v) {
  try {
    // accept "2025-08-10 18:00:00" and "2025-08-10T18:00:00Z"
    const s = String(v || "");
    const iso = s.includes("T") ? s : s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z");
    return new Date(iso).getTime();
  } catch {
    return null;
  }
}

export function DataProvider({ children }) {
  // CRYPTO
  const [crypto, setCrypto] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);

  // FOOTBALL
  const [football, setFootball] = useState([]);
  const [loadingFootball, setLoadingFootball] = useState(false);
  const [footballLastGenerated, setFootballLastGenerated] = useState(null);
  const [nextKickoffTs, setNextKickoffTs] = useState(null);

  // simple in-mem cooldowns so UI ne spamuje
  const lastCryptoFetch = useRef(0);
  const lastFootballFetch = useRef(0);

  const fetchCrypto = useCallback(async (force = false) => {
    const now = nowTs();
    if (!force && now - lastCryptoFetch.current < 15_000) return;
    lastCryptoFetch.current = now;

    setLoadingCrypto(true);
    try {
      const res = await fetch("/api/crypto");
      const json = await res.json();
      const list = Array.isArray(json?.crypto) ? json.crypto : [];
      setCrypto(list);
      // sledeći refresh za ~10 min, ako backend ne pošalje drugačije
      setNextCryptoUpdate(nowTs() + 10 * 60_000);
    } catch (e) {
      // noop
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  const fetchFootball = useCallback(async (force = false) => {
    const now = nowTs();
    if (!force && now - lastFootballFetch.current < 15_000) return;
    lastFootballFetch.current = now;

    setLoadingFootball(true);
    try {
      const res = await fetch("/api/value-bets");
      const json = await res.json();
      const list = Array.isArray(json?.value_bets) ? json.value_bets : [];
      setFootball(list);
      setFootballLastGenerated(json?.generated_at || null);

      // izračunaj najbliži kickoff iz response-a
      let minTs = null;
      for (const it of list) {
        const dt =
          it?.datetime_local?.starting_at?.date_time ||
          it?.datetime_local?.date_time ||
          it?.starting_at?.date_time ||
          null;
        const ts = dt ? tsFromISO(dt) : null;
        if (ts && (minTs === null || ts < minTs) && ts > nowTs()) minTs = ts;
      }
      setNextKickoffTs(minTs);
    } catch (e) {
      // noop
    } finally {
      setLoadingFootball(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchCrypto(true);
    fetchFootball(true);
  }, [fetchCrypto, fetchFootball]);

  useEffect(() => {
    // inicijalni load posle mount-a (SSR-safe)
    fetchCrypto(false);
    fetchFootball(false);
    // povremeno osvežavanje
    const t = setInterval(() => {
      fetchCrypto(false);
      fetchFootball(false);
    }, 60_000);
    return () => clearInterval(t);
  }, [fetchCrypto, fetchFootball]);

  const value = useMemo(
    () => ({
      // crypto
      crypto,
      loadingCrypto,
      nextCryptoUpdate,

      // football
      football,
      loadingFootball,
      footballLastGenerated,
      nextKickoffTs,

      // actions
      refreshAll,
    }),
    [
      crypto,
      loadingCrypto,
      nextCryptoUpdate,
      football,
      loadingFootball,
      footballLastGenerated,
      nextKickoffTs,
      refreshAll,
    ]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
