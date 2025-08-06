// pages/api/crypto.js
import { fetchCoinGeckoPrices } from '../../lib/sources/coingecko';
import { fetchCryptoComparePrices } from '../../lib/sources/cryptocompare';
import { fetchCoinPaprikaPrices } from '../../lib/sources/coinpaprika';

// In-memory store of last fetched prices to compute change over interval
let previousPrices = {};

// List of top symbols to track
const MAPPINGS = [
  { gecko: 'bitcoin',        cc: 'BTC',   cp: 'btc-bitcoin'           },
  { gecko: 'ethereum',       cc: 'ETH',   cp: 'eth-ethereum'          },
  { gecko: 'binancecoin',    cc: 'BNB',   cp: 'bnb-binance-coin'      },
  { gecko: 'cardano',        cc: 'ADA',   cp: 'ada-cardano'           },
  { gecko: 'solana',         cc: 'SOL',   cp: 'sol-solana'            },
  { gecko: 'ripple',         cc: 'XRP',   cp: 'xrp-xrp'               },
  { gecko: 'dogecoin',       cc: 'DOGE',  cp: 'dogecoin-dogecoin'     },
  { gecko: 'polkadot',       cc: 'DOT',   cp: 'dot-polkadot'          },
  { gecko: 'polygon',        cc: 'MATIC', cp: 'matic-network-matic'   },
  { gecko: 'litecoin',       cc: 'LTC',   cp: 'litecoin-litecoin'     },
];

export default async function handler(req, res) {
  try {
    // 1) Fetch prices from each source
    const ids = MAPPINGS.map(m => m.gecko);
    const symbols = MAPPINGS.map(m => m.cc);
    const cpIds = MAPPINGS.map(m => m.cp);

    const [cgData, ccData, cpData] = await Promise.all([
      fetchCoinGeckoPrices(ids).catch(() => ({})),
      fetchCryptoComparePrices(symbols).catch(() => ({})),
      fetchCoinPaprikaPrices(cpIds).catch(() => ({})),
    ]);

    // 2) Build unified price list with fallback
    const unified = MAPPINGS.map(m => {
      let price = null;
      if (cgData[m.gecko]?.usd !== undefined) price = cgData[m.gecko].usd;
      else if (ccData[m.cc]?.USD !== undefined) price = ccData[m.cc].USD;
      else if (cpData[m.cp]?.price_usd !== undefined) price = cpData[m.cp].price_usd;
      return { symbol: m.cc, price };
    }).filter(item => item.price != null);

    // 3) Compute simple signal & confidence based on change since last fetch
    const signals = unified.map(item => {
      const prev = previousPrices[item.symbol] ?? item.price;
      const change = (item.price - prev) / prev;         // fractional change
      const signal = change >= 0 ? 'LONG' : 'SHORT';
      const confidence = Math.min(Math.abs(change) * 100, 100).toFixed(2);
      // update cache
      previousPrices[item.symbol] = item.price;
      return {
        symbol: item.symbol,
        price: item.price,
        signal,
        confidence: Number(confidence),
        changePercent: (change * 100).toFixed(2),
      };
    });

    // 4) Sort by absolute strength and pick top subsets
    signals.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    const top10 = signals.slice(0, 10);
    const top3  = top10.slice(0, 3);

    // 5) Cache control for Vercel: 10 minutes
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate');

    // 6) Return structured result
    res.status(200).json({
      combined: top3,
      crypto:   top10
    });

  } catch (error) {
    console.error('API /crypto error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
