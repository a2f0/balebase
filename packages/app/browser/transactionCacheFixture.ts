import {
  clearFormerOrganizations,
  clearUserTransactions,
  indexedDbTransactionStore,
  pullTransactions,
} from "../src/finance/transactionCache";

declare global {
  interface Window {
    transactionCacheTest?: {
      clearFormerOrganizations: typeof clearFormerOrganizations;
      clearUserTransactions: typeof clearUserTransactions;
      pullTransactions: typeof pullTransactions;
      store: ReturnType<typeof indexedDbTransactionStore>;
    };
  }
}

window.transactionCacheTest = {
  clearFormerOrganizations,
  clearUserTransactions,
  pullTransactions,
  store: indexedDbTransactionStore(),
};
