/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // NEMA preusmeravanja /api/value-bets -> /api/value-bets-locked
  // Front neka direktno zove /api/value-bets-locked

  async headers() {
    return [
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      // Crypto API se nikad ne kešira na edge/CDN
      { source: '/api/crypto', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },

  async rewrites() {
    return [
      // (postojeći rewrite – NE diramo fudbal)
      { source: '/api/value-bets-locked-slim', destination: '/api/value-bets-locked?shape=slim' },

      // ---------- KRIPTO SAMO (bez uticaja na fudbal) ----------
      // Postojeći UI za dashboard/combined najčešće očekuje "čist niz".
      // Zato crypto tab preusmeravamo na /api/crypto?shape=slim (vraća array).

      // /api/dashboard?tab=crypto  →  /api/crypto?shape=slim
      {
        source: '/api/dashboard',
        has: [{ type: 'query', key: 'tab', value: 'crypto' }],
        destination: '/api/crypto?shape=slim',
      },
      // /api/combined?tab=crypto  →  /api/crypto?shape=slim
      {
        source: '/api/combined',
        has: [{ type: 'query', key: 'tab', value: 'crypto' }],
        destination: '/api/crypto?shape=slim',
      },

      // eksplicitni aliasi koji se ponekad koriste
      { source: '/api/combined-crypto', destination: '/api/crypto?shape=slim' },
      { source: '/api/crypto-feed',     destination: '/api/crypto?shape=slim' },
      { source: '/api/crypto-signals',  destination: '/api/crypto?shape=slim' },

      // generički bridge ako UI šalje type/sport/source=crypto
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'type', value: 'crypto' }],
        destination: '/api/crypto?shape=slim',
      },
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'sport', value: 'crypto' }],
        destination: '/api/crypto?shape=slim',
      },
      {
        source: '/api/:path*',
        has: [{ type: 'query', key: 'source', value: 'crypto' }],
        destination: '/api/crypto?shape=slim',
      },
    ];
  },
};

module.exports = nextConfig;
