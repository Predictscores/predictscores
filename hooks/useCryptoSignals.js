// FILE: hooks/useCryptoSignals.js
import { useContext, useMemo } from 'react';
import { DataContext } from '../contexts/DataContext';

export default function useCryptoSignals(limit) {
  const { longSignals, shortSignals, loadingCrypto, cryptoError } = useContext(DataContext);

  const crypto = useMemo(() => {
    const L = (longSignals || []).map((s) => ({ ...s, side: 'LONG' }));
    const S = (shortSignals || []).map((s) => ({ ...s, side: 'SHORT' }));
    const all = [...L, ...S].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return typeof limit === 'number' ? all.slice(0, limit) : all;
  }, [longSignals, shortSignals, limit]);

  return {
    crypto,
    loading: loadingCrypto,
    error: cryptoError
  };
}
