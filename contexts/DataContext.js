// contexts/DataContext.js
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Public context shape
 */
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

/**
 * Hook za lak pristup kontekstu
 */
export function useData() {
  return useContext(DataContext) || {};
}

/* Helpers */
function nowTs() {
  return Date.now();
}
function tsFromISO(v) {
  try {
    const s = String(v || "");
    const iso = s.includes("T") ? s : s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z");
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Provider
 */
export function DataProvider({ children }) {
  // === CRYPTO ===
  const [crypto, setCrypto] = useState([]);
  const [loadingCrypto, setLoadingCrypto] = useState(false);
  const [nextCryptoUpdate, setNextCryptoUpdate] = useState(null);

  // === FOOTBALL ===
  const [football, setFootball] = useState([]);
  const [loadingFootball, setLoadingFootball] = useState(false);
  const [footballLastGenerated, setFootballLastGenerated] = useState(null);
  const [nextKickoffTs, setNextKickoffTs] = useState(null);

  // anti-spam cooldown (da ne rušimo deploy budžet)
  const lastCryptoFetch = useRef(0);
  const lastFootballFetch = useRef(0);

  // Robustno parsiranje crypto endpointa (podržava i stari i novi oblik)
  const parseCryptoPayload = (json) => {
    if (Array.isArray(json?.crypto)) {
      return json.crypto;
    }
    const long = Array.isArray(json?.long) ? json.long : [];
    const short = Array.isArray(json?.short) ? json.short : [];
    const merged = [...long, ...short];
    // Sortiraj po confidence ako postoji
    merged.sort((a, b) => (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0));
    return merged;
  };

  const fetchCrypto = useCallback(async (force = false) => {
    const now = nowTs();
    if (!force && now - lastCryptoFetch.current < 12_000) return; // 12s guard
    lastCryptoFetch.current = now;

    setLoadingCrypto(true);
    try {
      const res = await fetch("/api/crypto");
      const json = await res.json();
      const list = parseCryptoPayload(json);
      setCrypto(Array.isArray(list) ? list : []);
      // Sledeći refresh za ~10 min (frontend countdown)
      setNextCryptoUpdate(nowTs() + 10 * 60_000);
    } catch {
      // leave previous data
    } finally {
      setLoadingCrypto(false);
    }
  }, []);

  const fetchFootball = useCallback(async (force = false) => {
    const now = nowTs();
    if (!force && now - lastFootballFetch.current < 12_000) return; // 12s guard
    lastFootballFetch.current = now;

    setLoadingFootball(true);
    try {
      const res = await fetch("/api/value-bets");
      const json = await res.json();
      const list = Array.isArray(json?.value_bets) ? json.value_bets : [];
      setFootball(list);
      setFootballLastGenerated(json?.generated_at || null);

      // Izračunaj najbliži budući kickoff
      let minTs = null;
      for (const it of list) {
        const dtx =
          it?.datetime_local?.starting_at?.date_time ||
          it?.datetime_local?.date_time ||
          it?.starting_at?.date_time ||
          null;
        const ts = tsFromISO(dtx);
        if (ts && ts > nowTs() && (minTs === null || ts < minTs)) minTs = ts;
      }
      setNextKickoffTs(minTs);
    } catch {
      // leave previous data
    } finally {
      setLoadingFootball(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchCrypto(true);
    fetchFootball(true);
  }, [fetchCrypto, fetchFootball]);

  // Init + periodično osvežavanje
  useEffect(() => {
    // prvi load posle mount-a (SSR safe)
    fetchCrypto(false);
    fetchFootball(false);

    // blago pozadinsko osvežavanje (ne prečesto)
    const iv = setInterval(() => {
      fetchCrypto(false);
      fetchFootball(false);
    }, 60_000); // svake 1 min
    return () => clearInterval(iv);
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

/**
 * Za kompatibilnost sa import DataProvider default:
 */
export default DataProvider;
