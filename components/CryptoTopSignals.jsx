// FILE: components/CryptoTopSignals.jsx
import React from 'react';
import useCryptoSignals from '../hooks/useCryptoSignals';
import SignalCard from './SignalCard';

// Normalizacija i cap confidence-a na [5..95]
function normalizeConfidence(conf) {
  const raw = typeof conf === 'number' ? conf : 0;
  const pct = raw > 1 ? raw : raw * 100; // ako stigne u [0..1], prikaži u %
  const capped = Math.min(95, Math.max(5, Math.round(pct)));
  return capped;
}

// Ne prikazujemo stable coine
const STABLES = new Set([
  'USDT','USDC','USDE','DAI','TUSD','FDUSD','USDP','EURS','EURT','USTC'
]);

export default function CryptoTopSignals({ limit = 10 }) {
  const { crypto = [], loading, error } = useCryptoSignals();

  if (loading) return <div>Loading crypto signals...</div>;
  if (error) return <div>Error loading crypto signals</div>;

  // 1) cap-uj confidence (samo za prikaz/sort)
  const withConf = crypto.map((s) => ({
    ...s,
    confidence: normalizeConfidence(s.confidence),
  }));

  // 2) no-trade filter: stable OUT + expectedMove < 0.8% OUT
  let filtered = withConf.filter((s) => {
    const sym = String(s.symbol || '').toUpperCase();
    if (STABLES.has(sym)) return false;
    const move = typeof s.expectedMove === 'number' ? s.expectedMove : 0;
    return move >= 0.8;
  });

  // Fallback da ne ostane prazno (olabavi na 0.3%)
  if (filtered.length < Math.min(3, limit)) {
    filtered = withConf.filter((s) => {
      const sym = String(s.symbol || '').toUpperCase();
      if (STABLES.has(sym)) return false;
      const move = typeof s.expectedMove === 'number' ? s.expectedMove : 0;
      return move >= 0.3;
    });
  }

  // 3) najjači prvi (confidence, pa expectedMove kao tie-breaker)
  filtered.sort((a, b) => {
    const c = (b.confidence || 0) - (a.confidence || 0);
    if (c !== 0) return c;
    const em = (b.expectedMove || 0) - (a.expectedMove || 0);
    if (em !== 0) return em;
    return String(a.symbol).localeCompare(String(b.symbol));
  });

  const top = filtered.slice(0, limit);

  // VIZUELNO: vratili smo na “stari” izgled — jedna široka kartica po redu
  return (
    <div className="space-y-4">
      {top.map((signal) => (
        <SignalCard key={signal.symbol} data={signal} type="crypto" />
      ))}
      {top.length === 0 && (
        <div className="text-gray-500 text-sm">
          No crypto suggestions at the moment.
        </div>
      )}
    </div>
  );
}
