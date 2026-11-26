import type { FinanceCache, TransactionStore } from "@balebase/client-sdk";
import { balebase } from "../src/balebase";

declare global {
  interface Window {
    transactionCacheTest?: {
      finance: FinanceCache;
      store: TransactionStore;
    };
  }
}

const { financeCache } = balebase();
window.transactionCacheTest = {
  finance: financeCache,
  store: financeCache.indexedDbStore(),
};
