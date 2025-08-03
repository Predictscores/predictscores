// FILE: pages/_app.js
import '../styles/globals.css';
import { DataProvider } from '../contexts/DataContext';

export default function App({ Component, pageProps }) {
  return (
    <DataProvider>
      <div className="w-full px-6 md:px-12">
        <Component {...pageProps} />
      </div>
    </DataProvider>
  );
}
