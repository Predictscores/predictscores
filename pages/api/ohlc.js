// FILE: pages/api/ohlc.js
// OHLC feed za grafikon: Binance klines (30m, poslednja 24h)
// /api/ohlc?symbol=LINK  (opciono &interval=30m&limit=48)
// Vraća: { bars: [{time,open,high,low,close}], symbol }
export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol = '', interval = '30m', limit = '48' } = req.query;
    let s = String(symbol || '').trim().toUpperCase();
    if (!s) return res.status(400).json({ error: 'Missing symbol' });

    const hasQuote = /(USDT|USDC|USD)$/.test(s);
    const pair = hasQuote ? s : `${s}USDT`;

    const hosts = [
      'https://api.binance.com',
      'https://data-api.binance.vision',
      'https://www.binance.com'
    ];

    const params = new URLSearchParams({
      symbol: pair,
      interval: String(interval || '30m'),
      limit: String(limit || '48')
    });

    const headers = {
      accept: 'application/json',
      'user-agent': 'predictscores/1.0 (+vercel)'
    };

    let lastErr = null;
    for (const host of hosts) {
      try {
        const url = `${host}/api/v3/klines?${params.toString()}`;
        const r = await fetch(url, { headers, cache: 'no-store' });

        if (!r.ok) {
          const body = await r.text();
          lastErr = { host, status: r.status, body: body.slice(0, 200) };
          continue; // probaj sledeći host
        }

        const klines = await r.json();
        if (!Array.isArray(klines) || klines.length === 0) {
          lastErr = { host, status: 502, body: 'Empty klines' };
          continue;
        }

        const bars = klines.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4])
        }));

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
        return res.status(200).json({ symbol: pair, bars });
      } catch (e) {
        lastErr = { host, status: 500, body: String(e?.message || e) };
        continue;
      }
    }

    return res.status(502).json({ error: 'Upstream failed', detail: lastErr });
  } catch (e) {
    console.error('OHLC API fatal', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
