import {
  catchUpSavedTransactions,
  clearFormerOrganizations,
  clearUserTransactions,
  indexedDbTransactionStore,
  pullTransactions,
} from "../src/finance/transactionCache";

declare global {
  interface Window {
    transactionCacheTest?: {
      catchUpSavedTransactions: typeof catchUpSavedTransactions;
      clearFormerOrganizations: typeof clearFormerOrganizations;
      clearUserTransactions: typeof clearUserTransactions;
      pullTransactions: typeof pullTransactions;
      store: ReturnType<typeof indexedDbTransactionStore>;
    };
  }
}

window.transactionCacheTest = {
  catchUpSavedTransactions,
  clearFormerOrganizations,
  clearUserTransactions,
  pullTransactions,
  store: indexedDbTransactionStore(),
};
