// FILE: hooks/useCryptoSignals.js
import { useEffect, useMemo, useState } from 'react';

export default function useCryptoSignals(limit = 10) {
  const [crypto, setCrypto] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/crypto', { headers: { 'cache-control': 'no-cache' } });
      const json = await res.json();
      const list = Array.isArray(json?.crypto) ? json.crypto : [];
      setCrypto(list);
      setLoading(false);
    } catch (e) {
      setError(e);
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10 * 60 * 1000); // svakih 10 min
    return () => clearInterval(t);
  }, []);

  const top = useMemo(() => {
    return crypto
      .slice()
      .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
      .slice(0, limit);
  }, [crypto, limit]);

  return { crypto: top, loading, error };
}
