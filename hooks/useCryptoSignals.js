// FILE: hooks/useCryptoSignals.js
import { useContext, useMemo } from 'react';
import { DataContext } from '../contexts/DataContext';

/**
 * Vraća kripto signale iz DataContext-a.
 * - Koristi SPOJENI i već SORTIRANI niz `crypto` (score DESC).
 * - Fallback: ako `crypto` nije niz, vraća prazan niz.
 * - Opcioni `limit` da preseče broj kartica.
 */
export default function useCryptoSignals(limit) {
  const { crypto, loadingCrypto, cryptoError } = useContext(DataContext);

  const result = useMemo(() => {
    const arr = Array.isArray(crypto) ? crypto : [];
    return typeof limit === 'number' ? arr.slice(0, limit) : arr;
  }, [crypto, limit]);

  return {
    crypto: result,
    loading: !!loadingCrypto,
    error: cryptoError || null,
  };
}
