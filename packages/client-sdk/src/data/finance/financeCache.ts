import { ApiError } from "@balebase/api-client";
import type {
  FinanceData,
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";

/** Whose transactions a device keeps: one person in one organization. */
export interface CacheScope {
  organizationId: string;
  userId: string;
}

export type FinanceSummary = Omit<FinanceData, "nextCursor" | "transactions">;

/** What this device keeps for a scope. */
interface CachedFinance {
  /** The feed cursor the transactions are as of; null before any page. */
  cursor: string | null;
  /** When a pull last caught up with the server; none before the first. */
  completedAt: string | null;
  /** Connections, accounts, and categories as last read online. */
  summary: FinanceSummary | null;
  transactions: FinanceTransaction[];
}

/**
 * Where a pull stands: the kept cursor, and the epoch, which signing out
 * (for the person) or a refusal (for the scope) advances so nothing
 * requested before it is kept after.
 */
interface Position {
  cursor: string | null;
  epoch: string;
}

/** Raised for a response from another organization than the scope's. */
export class OrganizationChanged extends Error {
  constructor() {
    super("The signed-in account or organization changed. Reload Finance.");
  }
}

/**
 * A refusal (signed out, no Finance access, a sign-out overtaking a pull)
 * rather than an unreachable server: nothing saved or shown may outlast it.
 */
export function refused(cause: unknown) {
  return (
    cause instanceof SignedOut ||
    (cause instanceof ApiError &&
      (cause.status === 401 || cause.status === 403))
  );
}

/** Raised for a write that arrives after its saved copy was cleared. */
export class SignedOut extends Error {
  constructor() {
    super("Saved transactions were cleared. Reload Finance.");
  }
}

/** Where a device keeps transactions: IndexedDB, or memory without it. */
export interface TransactionStore {
  read(scope: CacheScope): Promise<CachedFinance>;
  /** Where a pull starts; `saved` once any page (even an empty one) was. */
  position(scope: CacheScope): Promise<Position & { saved: boolean }>;
  /**
   * Applies one feed page, with its cursor, in one write, if the kept cursor
   * is still `from`'s. False when another pull (another tab) moved it first;
   * `SignedOut` when the person signed out since `from` was read.
   */
  apply(
    scope: CacheScope,
    from: Position,
    page: FinanceTransactionChanges,
    now: string,
  ): Promise<boolean>;
  /** Keeps the summary, unless the copy was cleared since `epoch`. */
  saveSummary(
    scope: CacheScope,
    summary: FinanceSummary,
    epoch: string,
  ): Promise<void>;
  /** Starts the copy over for a server that is behind it. */
  restart(scope: CacheScope, from: Position): Promise<void>;
  /**
   * Drops the copy after a refusal, ending pulls still running, and tells
   * other tabs unless `announce` is false (they told this one).
   */
  clear(scope: CacheScope, announce?: boolean): Promise<void>;
}

/** A clearing other tabs hear of: one scope, or a person's, but `except`. */
export interface Cleared {
  except?: string[] | undefined;
  organizationId?: string | undefined;
  userId: string;
}

/** Whether a clearing announced elsewhere covers `scope`. */
export function clears(cleared: Cleared, scope: CacheScope) {
  if (cleared.userId !== scope.userId) return false;
  if (cleared.organizationId !== undefined)
    return cleared.organizationId === scope.organizationId;
  return !cleared.except?.includes(scope.organizationId);
}

/**
 * How long a feed page may take: a request that stalls must not hold the
 * pull (and the lock other tabs wait on) after its page is no longer
 * wanted. The next load resumes from the last saved page.
 */
const pageTimeoutMs = 60_000;

/** `work`, or a timeout error once it takes longer than a feed page may. */
export function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Downloading transactions timed out. Try again.")),
      pageTimeoutMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}
