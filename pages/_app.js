import DataProvider from '../contexts/DataContext';

export default function App({ Component, pageProps }) {
  return (
    <DataProvider>
      <Component {...pageProps} />
    </DataProvider>
  );
}
