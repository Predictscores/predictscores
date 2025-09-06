/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // NEMA preusmeravanja /api/value-bets -> /api/value-bets-locked
  // Front neka direktno zove /api/value-bets-locked

  async headers() {
    return [
      {
        source: '/',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },

  async rewrites() {
    return [
      // (postojeci rewrite – NE diramo fudbal)
      { source: '/api/value-bets-locked-slim', destination: '/api/value-bets-locked?shape=slim' },

      // -----------------------------
      //  KRIPTO SAMO (bez uticaja na fudbal)
      //  Ako UI šalje query param koji kaže da je tab/type/sport=crypto,
      //  preusmeri na /api/crypto. Fudbal ovo NIKAD ne pogađa.
      // -----------------------------

      // /api/bilo-sta?sport=crypto → /api/crypto
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'sport', value: 'crypto' }],
        destination: '/api/crypto',
      },
      // /api/bilo-sta?type=crypto → /api/crypto
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'type', value: 'crypto' }],
        destination: '/api/crypto',
      },
      // /api/bilo-sta?tab=crypto → /api/crypto   (npr. combined tab)
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'tab', value: 'crypto' }],
        destination: '/api/crypto',
      },
      // /api/bilo-sta?source=crypto → /api/crypto
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'source', value: 'crypto' }],
        destination: '/api/crypto',
      },

      // Eksplicitni kripto feed aliasi (bezbedni jer sadrže "crypto" u path-u)
      { source: '/api/combined-crypto', destination: '/api/crypto' },
      { source: '/api/crypto-feed',     destination: '/api/crypto' },
      { source: '/api/crypto-signals',  destination: '/api/crypto' },

      // Ako UI zove /api/combined?tab=crypto → /api/crypto (često korišćeno ime)
      {
        source: '/api/combined',
        has: [{ type: 'query', key: 'tab', value: 'crypto' }],
        destination: '/api/crypto',
      },
    ];
  },
};

module.exports = nextConfig;
