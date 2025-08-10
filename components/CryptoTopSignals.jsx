import React from 'react';
import useCryptoSignals from '../hooks/useCryptoSignals';
import SignalCard from './SignalCard';

function normalizeConfidence(conf) {
  const raw = typeof conf === 'number' ? conf : 0;
  const pct = raw > 1 ? raw : raw * 100;
  return Math.min(95, Math.max(5, Math.round(pct)));
}

const STABLES = new Set(['USDT','USDC','USDE','DAI','TUSD','FDUSD','USDP','EURS','EURT','USTC']);

export default function CryptoTopSignals({ limit = 10 }) {
  const { data = [], loading } = useCryptoSignals(limit);

  if (loading) return <div>Loading crypto signals...</div>;

  const withConf = data.map(s => ({ ...s, confidence: normalizeConfidence(s.confidence) }));

  let filtered = withConf.filter(s => !STABLES.has(String(s.symbol||'').toUpperCase()) &&
                                     (typeof s.expectedMove === 'number' ? s.expectedMove : 0) >= 0.8);

  if (filtered.length < Math.min(3, limit)) {
    filtered = withConf.filter(s => !STABLES.has(String(s.symbol||'').toUpperCase()) &&
                                   (typeof s.expectedMove === 'number' ? s.expectedMove : 0) >= 0.3);
  }

  filtered.sort((a, b) => (b.confidence - a.confidence) || ((b.expectedMove||0)-(a.expectedMove||0)) || String(a.symbol).localeCompare(String(b.symbol)));
  const top = filtered.slice(0, limit);

  return (
    <div className="space-y-4">
      {top.map(sig => <SignalCard key={sig.symbol} data={sig} type="crypto" />)}
      {top.length === 0 && <div className="text-gray-500 text-sm">No crypto suggestions at the moment.</div>}
    </div>
  );
}
