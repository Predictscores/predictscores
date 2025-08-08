// FILE: contexts/DataContext.js
import { createContext, useState, useEffect, useCallback, useMemo } from 'react';

export const DataContext = createContext();

function percentileRank(arr, v) {
  if (!Array.isArray(arr) || arr.length === 0) return 50;
  let c = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] <= v) c++;
  return (c / arr.length) * 100;
}
function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
function computeRR(item) {
  const e = Number(item.entryPrice ?? 0);
  const tp = Number(item.tp ?? 0);
  const sl = Number(item.sl ?? 0);
  const eps = 1e-9;
  if (item.signal === 'SHORT') {
    const risk = Math.max(sl - e, eps);
    const reward = Math.max(e - tp, 0);
    return reward / risk;
  }
  const risk = Math.max(e - sl, eps);
  const reward = Math.max(tp - e, 0);
  return reward / risk;
}
function scoreAndTier(items) {
  const feats = items.map((s) => {
    const sign = s.signal === 'SHORT' ? -1 : 1;
    const m1 = sign * Number(s.change1h ?? 0);
    const m24 = sign * Number(s.change24h ?? 0);
    const em = Math.abs(Number(s.expectedMove ?? 0));
    const rr = computeRR(s);
    return { m1, m24, em, rr };
  });

  const a1 = feats.map((f) => f.m1);
  const a24 = feats.map((f) => f.m24);
  const aem = feats.map((f) => f.em);
  const arr = feats.map((f) => f.rr);

  return items.map((s, idx) => {
    const f = feats[idx];
    const p1 = percentileRank(a1, f.m1);
    const p24 = percentileRank(a24, f.m24);
    const pem = percentileRank(aem, f.em);
    const prr = percentileRank(arr, f.rr);

    // ponderisano: 0–100
    let score = 0.35 * p24 + 0.25 * p1 + 0.25 * pem + 0.15 * prr;
    score = Math.max(0, Math.min(100, score));

    let tier = 'low';
    if (score >= 90) tier = 'top';
    else if (score >= 75) tier = 'high';
    else if (score >= 50) tier = 'moderate';

    return {
      ...s,
      confidence: score, // koristimo score kao confidence 0–100
      score,
      tier,
    };
  });
}

export function DataProvider({ children }) {
  const [rawLong, setRawLong] = useState([]);
  const [rawShort, setRawShort] = useState([]);
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
        throw new Error('Crypto API bad response');
      }
      const json = await res.json();

      // podrži više formata: {long,short} ili {signals} ili {crypto}
      let L = [];
      let S = [];
      if (Array.isArray(json.long) || Array.isArray(json.short)) {
        L = Array.isArray(json.long) ? json.long : [];
        S = Array.isArray(json.short) ? json.short : [];
      } else if (Array.isArray(json.signals)) {
        L = json.signals.filter((x) => x.signal === 'LONG');
        S = json.signals.filter((x) => x.signal === 'SHORT');
      } else if (Array.isArray(json.crypto)) {
        const both = json.crypto;
        L = both.filter((x) => x.signal === 'LONG');
        S = both.filter((x) => x.signal === 'SHORT');
        // ako nema SHORT-ova, ostaje samo LONG – to je ok
      }

      setRawLong(L);
      setRawShort(S);
      setNextCryptoUpdate(Date.now() + 10 * 60 * 1000);
    } catch (e) {
      console.error('fetchCrypto error', e);
      setRawLong([]);
      setRawShort([]);
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

  // SPOJENO + SCORE + SORT — bez deljenja na LONG/SHORT
  const crypto = useMemo(() => {
    const L = (rawLong || []).map((x) => ({ ...x, side: 'LONG' }));
    const S = (rawShort || []).map((x) => ({ ...x, side: 'SHORT' }));
    const all = [...L, ...S];
    if (all.length === 0) return [];

    const withScores = scoreAndTier(all);
    withScores.sort((a, b) => (b.score || 0) - (a.score || 0));
    return withScores;
  }, [rawLong, rawShort]);

  const refreshCrypto = useCallback(() => fetchCrypto(), [fetchCrypto]);
  const refreshAll = useCallback(() => { fetchCrypto(); }, [fetchCrypto]);

  return (
    <DataContext.Provider
      value={{
        crypto,            // već SORITIRANO po score DESC
        loadingCrypto,
        cryptoError,
        nextCryptoUpdate,
        refreshCrypto,
        refreshAll,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}
