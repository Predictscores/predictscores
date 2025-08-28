// pages/_app.js
import "../styles/globals.css";
import { DataProvider } from "../contexts/DataContext";

export default function MyApp({ Component, pageProps }) {
  return <DataProvider><Component {...pageProps} /></DataProvider>;
}
