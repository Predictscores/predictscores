/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      // Sve zahteve ka /api/value-bets (npr. iz starih bundle-ova) preusmeri na -locked,
      // osim kada naš backend interno šalje header x-locked-proxy (da izbegnemo petlju).
      {
        source: "/api/value-bets",
        has: [{ type: "header", key: "x-locked-proxy", value: "1" }],
        destination: "/api/value-bets", // dozvoli prolaz samo za interne pozive
      },
      {
        source: "/api/value-bets",
        destination: "/api/value-bets-locked",
      },
    ];
  },

  async headers() {
    return [
      {
        // Za sve HTML rute (sve što NIJE /api ili /_next) — zabrani browser keš da ne vidiš staru verziju stranice
        source: "/((?!_next|api).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
