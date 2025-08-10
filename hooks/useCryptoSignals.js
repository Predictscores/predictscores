import { useContext, useMemo } from 'react';
import { DataContext } from '../contexts/DataContext';

export default function useCryptoSignals(limit = 10) {
  const ctx = useContext(DataContext) || {};
  const list = Array.isArray(ctx.crypto) ? ctx.crypto : [];
  const top = useMemo(() => {
    return list
      .slice()
      .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
      .slice(0, limit);
  }, [list, limit]);

  return {
    data: top,
    loading: !!ctx.loadingCrypto,
    nextRefreshAt: ctx.cryptoNextRefreshAt || null,
  };
}
