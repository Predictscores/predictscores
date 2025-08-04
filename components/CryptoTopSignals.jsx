// FILE: components/CryptoTopSignals.jsx
import React, { useEffect, useState } from 'react';
import SignalCard from './SignalCard';

export default function CryptoTopSignals({
  refreshIntervalMs = 10000,
  limit = 6,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchSignals = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/crypto');
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${text}`);
      }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message || 'Fetch error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSignals();
    const iv = setInterval(fetchSignals, refreshIntervalMs);
    return () => clearInterval(iv);
  }, [refreshIntervalMs]);

  if (loading) {
    return (
      <div className="bg-[#1f2339] p-4 rounded-2xl text-center text-gray-300">
        Učitavanje kripto signala...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#1f2339] p-4 rounded-2xl text-red-300">
        Greška učitavanja kripto signala: {error}{' '}
        <button
          onClick={fetchSignals}
          className="ml-2 underline font-medium text-white"
        >
          Pokušaj ponovo
        </button>
      </div>
    );
  }

  const top = (data?.cryptoTop || []).slice(0, limit);

  if (top.length === 0) {
    return (
      <div className="bg-[#1f2339] p-4 rounded-2xl text-center text-gray-400">
        Nema dostupnih kripto signala.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Top Crypto Signals</h2>
      <div className="grid grid-cols-1 gap-6">
        {top.map((sig, idx) => (
          <div
            key={idx}
            className="bg-[#1f2339] p-5 rounded-2xl shadow flex"
            style={{ alignItems: 'stretch' }}
          >
            <SignalCard data={sig} type="crypto" />
          </div>
        ))}
      </div>
    </div>
  );
}
