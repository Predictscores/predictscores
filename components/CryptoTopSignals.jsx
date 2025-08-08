// FILE: components/CryptoTopSignals.jsx
import React from 'react';
import useCryptoSignals from '../hooks/useCryptoSignals';
import SignalCard from './SignalCard';

const CryptoTopSignals = ({ limit = 10 }) => {
  const { crypto = [], loading, error } = useCryptoSignals(limit);

  if (loading) return <div>Loading crypto signals...</div>;
  if (error) return <div>Error loading crypto signals</div>;
  if (!crypto.length) return <div className="p-6 text-center opacity-70">Nema dostupnog kripto signala</div>;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
      {crypto.map((signal, idx) => (
        <SignalCard key={`${signal.symbol}-${signal.side}-${idx}`} data={signal} type="crypto" />
      ))}
    </div>
  );
};

export default CryptoTopSignals;
