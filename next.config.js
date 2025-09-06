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
      // Snapshot još zove /api/value-bets-locked-slim -> preusmeri na unified endpoint u "slim" modu
      { source: '/api/value-bets-locked-slim', destination: '/api/value-bets-locked?shape=slim' },
    ];
  },
};

module.exports = nextConfig;
