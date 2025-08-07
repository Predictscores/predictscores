// FILE: components/CryptoTopSignals.jsx

import React from 'react';
import useCryptoSignals from '../hooks/useCryptoSignals';
import SignalCard from './SignalCard';

const CryptoTopSignals = ({ limit = 10 }) => {
  // Osiguravamo da je crypto uvek niz
  const { crypto = [], loading, error } = useCryptoSignals();

  if (loading) return <div>Loading crypto signals...</div>;
  if (error) return <div>Error loading crypto signals</div>;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
      {crypto.slice(0, limit).map((signal) => (
        // Sada signal pakujemo u `data`, pa u SignalCard-u
        // više ne čitamo undefined
        <SignalCard key={signal.symbol} data={signal} type="crypto" />
      ))}
    </div>
  );
};

export default CryptoTopSignals;
