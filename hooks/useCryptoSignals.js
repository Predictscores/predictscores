// hooks/useCryptoSignals.js
import { useState, useEffect } from 'react';

export default function useCryptoSignals() {
  const [crypto, setCrypto] = useState([]);
  const [combined, setCombined] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function fetchData() {
    try {
      const res = await fetch('/api/crypto');
      const json = await res.json();
      setCombined(json.combined || []);
      setCrypto(json.crypto || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 10 * 60 * 1000); // 10 min
    return () => clearInterval(iv);
  }, []);

  return { combined, crypto, loading, error };
}
