import {
  clearUserTransactions,
  indexedDbTransactionStore,
  pullTransactions,
} from "../src/finance/transactionCache";

declare global {
  interface Window {
    transactionCacheTest?: {
      clearUserTransactions: typeof clearUserTransactions;
      pullTransactions: typeof pullTransactions;
      store: ReturnType<typeof indexedDbTransactionStore>;
    };
  }
}

window.transactionCacheTest = {
  clearUserTransactions,
  pullTransactions,
  store: indexedDbTransactionStore(),
};
