// FILE: pages/index.js
import Head from 'next/head';
import dynamic from 'next/dynamic';

// Isključi SSR za sadržaj početne strane (stabilno za live podatke)
const CombinedBets = dynamic(() => import('../components/CombinedBets'), { ssr: false });

function HomePage() {
  return (
    <>
      <Head>
        <title>Predictscores — Live Picks</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <main className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        <CombinedBets />
      </main>
    </>
  );
}

// Dodatno osiguranje: i samu stranicu izvozimo bez SSR-a
export default dynamic(() => Promise.resolve(HomePage), { ssr: false });
