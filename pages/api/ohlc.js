// FILE: pages/api/ohlc.js
// OHLC feed za grafikon: Binance klines (30m, poslednja 24h)
// Upotreba: /api/ohlc?symbol=LINK (opciono &interval=30m&limit=48)
// Vraća: { bars: [{time, open, high, low, close}], symbol }

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol = '', interval = '30m', limit = '48' } = req.query;
    let s = String(symbol || '').trim().toUpperCase();

    if (!s) return res.status(400).json({ error: 'Missing symbol' });

    // Ako već ima sufiks, koristi ga; inače dodaj USDT
    const hasQuote = /(USDT|USDC|USD)$/.test(s);
    const pair = hasQuote ? s : `${s}USDT`;

    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
      pair
    )}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;

    const r = await fetch(url, { headers: { 'accept': 'application/json' } });

    if (!r.ok) {
      const text = await r.text();
      return res
        .status(r.status)
        .json({ error: 'Upstream error', status: r.status, body: text.slice(0, 200) });
    }

    const klines = await r.json();
    // Mapiramo u (sekunde) i brojčane vrednosti
    const bars = Array.isArray(klines)
      ? klines.map((k) => ({
          time: Math.floor(k[0] / 1000),    // open time (sec)
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4])
        }))
      : [];

    // 24h = 48 sveća po 30m → već pokriveno default "limit"
    res.setHeader('Content-Type', 'application/json');
    // Keš za edge razumnu (2 min), pa SWR
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({ symbol: pair, bars });
  } catch (e) {
    console.error('OHLC API error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
