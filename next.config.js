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
};

module.exports = nextConfig;
