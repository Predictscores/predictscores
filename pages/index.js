// FILE: pages/index.js

import { useContext } from 'react';
import { DataContext } from '../contexts/DataContext';
import SignalCard from '../components/SignalCard';

export default function Home() {
  const {
    cryptoData,
    footballData,
    loading,
    refreshAll,
    nextCryptoUpdate,
    nextFootballUpdate,
  } = useContext(DataContext);

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getCountdown = (targetTime) => {
    const diff = targetTime - Date.now();
    if (diff <= 0) return 'Now';
    const mins = Math.floor(diff / 60000);
    const secs = Math.floor((diff % 60000) / 1000);
    return `${mins}m ${secs}s`;
  };

  return (
    <main className="min-h-screen p-4 bg-background text-foreground">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">AI Top fudbalske i Kripto Prognoze</h1>
        <div className="flex items-center space-x-2">
          <button
            onClick={refreshAll}
            className="px-3 py-1 border rounded text-sm hover:bg-accent"
          >
            Refresh all
          </button>
          <button
            onClick={() => {
              document.documentElement.classList.toggle('dark');
            }}
            className="px-3 py-1 border rounded text-sm hover:bg-accent"
          >
            Light mode
          </button>
        </div>
      </div>

      <div className="text-sm mb-6 text-muted-foreground">
        <div>Football last generated: {formatTime(footballData?.generated_at)}</div>
        <div>Crypto next refresh in: {getCountdown(nextCryptoUpdate)}</div>
      </div>

      <div className="mb-6">
        <h2 className="text-xl font-semibold mb-2">Combined Top Picks</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-4">
              {footballData?.footballTop?.[i] && (
                <SignalCard data={footballData.footballTop[i]} type="football" />
              )}
              {cryptoData?.cryptoTop?.[i] && (
                <SignalCard data={cryptoData.cryptoTop[i]} type="crypto" />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="text-sm text-center text-muted-foreground mt-10">
        Confidence: <span className="text-green-500">🟢 High (≥85%)</span> ·{' '}
        <span className="text-blue-500">🔵 Moderate (55–84%)</span> ·{' '}
        <span className="text-yellow-500">🟡 Low (&lt;55%)</span>
      </div>
    </main>
  );
}
