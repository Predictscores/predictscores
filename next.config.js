/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Svi spoljašnji pozivi na /api/value-bets idu na zaključani endpoint
  async rewrites() {
    return [
      { source: '/api/value-bets', destination: '/api/value-bets-locked' },
    ];
  },

  // HTML za početnu nek se ne kešira na CDN-u posle deploya
  async headers() {
    return [
      {
        source: '/',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ];
  },
};

module.exports = nextConfig;
