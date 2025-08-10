// hooks/useCryptoSignals.js
import { useContext } from "react";
import { DataContext } from "../contexts/DataContext";

export default function useCryptoSignals() {
  const ctx = useContext(DataContext) || {};
  return {
    crypto: Array.isArray(ctx.crypto) ? ctx.crypto : [],
    loading: !!ctx.loadingCrypto,
    nextCryptoUpdate: ctx.nextCryptoUpdate || null,
  };
}
