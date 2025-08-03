// FILE: pages/_app.js
import '../styles/globals.css';
import { DataProvider } from '../contexts/DataContext';

export default function App({ Component, pageProps }) {
  return (
    <DataProvider>
      <div className="max-w-6xl mx-auto px-4 md:px-8">
        <Component {...pageProps} />
      </div>
    </DataProvider>
  );
}
