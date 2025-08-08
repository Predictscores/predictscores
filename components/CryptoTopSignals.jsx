// FILE: components/CryptoTopSignals.jsx
import React from 'react';
import useCryptoSignals from '../hooks/useCryptoSignals';
import SignalCard from './SignalCard';

export default function CryptoTopSignals({ limit = 10 }) {
  const { crypto, loading, error } = useCryptoSignals(limit);

  if (loading) {
    return <div className="text-slate-400">Loading crypto signals…</div>;
  }
  if (error) {
    return <div className="text-red-400">Error loading crypto signals</div>;
  }
  if (!crypto || crypto.length === 0) {
    return <div className="text-slate-400">Nema dostupnog kripto signala</div>;
  }

  // vertikalni stack kartica – svaka kartica je već "wide" (grid 2 kolone unutar sebe)
  return (
    <div className="space-y-4">
      {crypto.map((sig) => (
        <SignalCard key={(sig.symbol || '') + (sig.signal || '')} data={sig} />
      ))}
    </div>
  );
}
