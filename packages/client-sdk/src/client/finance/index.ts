import type { FinanceTransactionChanges } from "@balebase/validators/finance";
import type {
  CacheScope,
  Cleared,
  TransactionStore,
} from "../../data/finance/financeCache";
import {
  catchUpSavedTransactions,
  clearedOnRefusal,
  clearFormerOrganizations,
  clearScopeTransactions,
  clearUserTransactions,
  indexedDbTransactionStore,
  memoryTransactionStore,
  onCleared,
  onClearedElsewhere,
  pullTransactions,
} from "./transactionCache";

type FetchPage = (cursor: string | null) => Promise<FinanceTransactionChanges>;

/**
 * The transactions a device keeps for Finance, per person and organization:
 * IndexedDB where the browser has it, or memory. Pulls bring a copy up to
 * date a page at a time; a refusal, sign-out, or lost membership clears it
 * in every tab. Methods are bound, so they can be passed on as callbacks.
 */
export class FinanceCache {
  readonly #apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.#apiBaseUrl = apiBaseUrl;
  }

  /** The device's saved copies, in IndexedDB. */
  readonly indexedDbStore = (): TransactionStore =>
    indexedDbTransactionStore(this.#apiBaseUrl);

  /** Copies that last as long as the page, for browsers without IndexedDB. */
  readonly memoryStore = (): TransactionStore =>
    memoryTransactionStore(this.#apiBaseUrl);

  /**
   * Brings `store`'s copy of `scope` up to date a page at a time, resuming
   * from the last saved page. Tabs share the work through a Web Lock.
   * `anyOrganization` keeps pages of whichever organization answers.
   */
  readonly pull = (
    scope: CacheScope,
    store: TransactionStore,
    fetchPage: FetchPage,
    onProgress?: (saved: number) => void,
    anyOrganization = false,
  ) =>
    pullTransactions(
      this.#apiBaseUrl,
      scope,
      store,
      fetchPage,
      onProgress,
      anyOrganization,
    );

  /**
   * Brings a saved copy up to date after a change made away from the
   * overview; nothing happens without one. Raises only a refusal, having
   * cleared the copy (a sign-out cleared it already); other failures wait
   * for the next load.
   */
  readonly catchUp = (
    scope: CacheScope | undefined,
    fetchPage: FetchPage,
    store?: TransactionStore,
  ) =>
    store
      ? catchUpSavedTransactions(this.#apiBaseUrl, scope, fetchPage, store)
      : catchUpSavedTransactions(this.#apiBaseUrl, scope, fetchPage);

  /**
   * Drops the device's copy of `scope` and ends pulls still running for it,
   * telling other tabs unless `announce` is false.
   */
  readonly clearScope = (scope: CacheScope, announce = true) =>
    clearScopeTransactions(this.#apiBaseUrl, scope, announce);

  /** Drops a person's copies in organizations other than `organizationIds`. */
  readonly clearFormerOrganizations = (
    userId: string,
    organizationIds: string[],
  ) => clearFormerOrganizations(this.#apiBaseUrl, userId, organizationIds);

  /** Drops a person's copies in every organization, as on signing out. */
  readonly clearUser = (userId: string) =>
    clearUserTransactions(this.#apiBaseUrl, userId);

  /** `work`, clearing `scope`'s copy first when the server refuses it. */
  readonly clearedOnRefusal = <T>(
    scope: CacheScope | undefined,
    work: Promise<T>,
    clear: (scope: CacheScope) => Promise<void> = this.clearScope,
  ) => clearedOnRefusal(scope, work, clear);

  /** Calls `listener` when another tab clears saved transactions. */
  readonly onClearedElsewhere = (listener: (cleared: Cleared) => void) =>
    onClearedElsewhere(this.#apiBaseUrl, listener);

  /** Calls `listener` when any tab, this one included, clears them. */
  readonly onCleared = (listener: (cleared: Cleared) => void) =>
    onCleared(this.#apiBaseUrl, listener);
}
