import React, { useEffect, useState } from 'react';
import Tabs from '../components/Tabs';
import SignalCard from '../components/SignalCard';

const fetcher = (url) => fetch(url).then((r) => r.json());

export default function Home() {
  const [active, setActive] = useState('combined');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetcher('/api/crypto');
      setData(d);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  const tabs = [
    { key: 'combined', label: 'Crypto top signals' },
    { key: 'football', label: 'Football (coming)' }
  ];

  return (
    <div>
      <Tabs tabs={tabs} active={active} onChange={setActive} />
      {loading && <div className="card">Učitavanje signala...</div>}
      {!loading && error && (
        <div className="card">
          Greška: <pre>{error}</pre>
        </div>
      )}
      {!loading && data && (
        <>
          {active === 'combined' && (
            <div>
              <div style={{ marginBottom: 8, fontSize: '0.75rem' }}>
                Ažurirano: {new Date(data.generated_at).toLocaleString('sr-RS')}
              </div>
              <h2 style={{ marginTop: 0 }}>Combined Top 10</h2>
              {data.combined.map((it) => (
                <SignalCard key={`${it.symbol}-${it.timeframe}`} item={it} />
              ))}

              {['15m', '30m', '1h', '4h'].map((tf) => (
                <div key={tf}>
                  <h3>Top 10 — {tf}</h3>
                  {data.byTimeframe[tf] && data.byTimeframe[tf].length > 0 ? (
                    data.byTimeframe[tf].map((it) => (
                      <SignalCard key={`${it.symbol}-${tf}`} item={it} />
                    ))
                  ) : (
                    <div className="card small">Nema jakih signala za {tf}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {active === 'football' && (
            <div className="card">
              <div style={{ fontWeight: 600 }}>Football predikcije još nisu integrisane.</div>
              <div className="small">
                Pošalji mi te tri sportske API source informacije (endpoint format / primer odgovora i kako
                želiš konsenzus), pa ti odmah dam `/api/football.js` koji ih kombinuje.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
