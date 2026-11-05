import { describe, expect, it } from "bun:test";
import { ApiError } from "@balebase/api-client";
import type {
  FinanceData,
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { fallBack, loadFinance } from "./financeCacheLoad";
import {
  type CacheScope,
  memoryTransactionStore,
  SignedOut,
  type TransactionStore,
} from "./transactionCache";

const scope: CacheScope = { organizationId: "org", userId: "person" };

function row(id: string): FinanceTransaction {
  return {
    accountId: "account",
    accountName: "Checking",
    amount: 1,
    annotation: { labels: [], note: "", reviewed: false },
    authorizedDate: null,
    categoryDetailed: null,
    categoryPrimary: null,
    currencyCode: "USD",
    expenseCategoryId: null,
    id,
    linkedEmails: [],
    merchantName: null,
    name: id,
    paymentChannel: null,
    pending: false,
    transactionDate: "2026-01-01",
  };
}

const summary: FinanceData = {
  accounts: [],
  categories: [],
  configured: true,
  connections: [],
  nextCursor: null,
  transactions: [],
};

function feed(...ids: string[]): FinanceTransactionChanges {
  return {
    cursor: "1",
    more: false,
    organizationId: "org",
    removedIds: [],
    reset: false,
    transactions: ids.map(row),
  };
}

function failure(status: number) {
  return new ApiError(new Response(null, { status }), {
    error: `Status ${status}.`,
  });
}

const sources = {
  changes: async () => feed("a", "b"),
  onProgress: () => undefined,
  summary: async () => summary,
};

const ids = (data: FinanceData) => data.transactions.map(({ id }) => id).sort();

describe("loading cached finances", () => {
  it("clears the saved copy for a refused feed even while the summary is down", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    const offline = await loadFinance(store, scope, true, {
      ...sources,
      changes: async () => {
        throw new TypeError("Failed to fetch");
      },
      summary: async () => {
        throw failure(503);
      },
    });
    // An outage alone shows what was saved.
    expect(ids(offline.data)).toEqual(["a", "b"]);
    expect(offline.savedAt).toBeString();

    await expect(
      loadFinance(store, scope, true, {
        ...sources,
        changes: async () => {
          throw failure(403);
        },
        summary: async () => {
          throw failure(503);
        },
      }),
    ).rejects.toThrow("Status 403.");
    expect((await store.read(scope)).transactions).toEqual([]);
  });

  it("clears the saved copy when a page without transactions is refused", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    // The Categories page reads only the summary.
    await expect(
      loadFinance(store, scope, false, {
        ...sources,
        summary: async () => {
          throw failure(401);
        },
      }),
    ).rejects.toThrow("Status 401.");
    expect((await store.read(scope)).transactions).toEqual([]);
  });

  it("keeps the saved copy for errors that are not refusals", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    const limited = await loadFinance(store, scope, true, {
      ...sources,
      changes: async () => {
        throw failure(429);
      },
    });
    expect(ids(limited.data)).toEqual(["a", "b"]);
    expect(limited.savedAt).toBeString();
  });

  it("ends a pull that a sign-out overtakes instead of falling back to memory", async () => {
    const primary = memoryTransactionStore();
    const signingOut: TransactionStore = {
      ...primary,
      apply: async () => {
        throw new SignedOut();
      },
    };
    const secondary = memoryTransactionStore();
    let pulls = 0;
    await expect(
      loadFinance(fallBack(signingOut, secondary), scope, true, {
        ...sources,
        changes: async () => {
          pulls++;
          return feed("a");
        },
      }),
    ).rejects.toBeInstanceOf(SignedOut);
    expect(pulls).toBe(1);
    expect((await secondary.read(scope)).transactions).toEqual([]);
  });

  it("downloads again into memory when IndexedDB fails after a pull", async () => {
    const primary = memoryTransactionStore();
    const failing: TransactionStore = {
      ...primary,
      saveSummary: async () => {
        throw new DOMException("Quota exceeded.", "QuotaExceededError");
      },
    };
    const secondary = memoryTransactionStore();
    let pulls = 0;
    const loaded = await loadFinance(
      fallBack(failing, secondary),
      scope,
      true,
      {
        ...sources,
        changes: async () => {
          pulls++;
          return feed("a", "b");
        },
      },
    );
    // Not an empty list read from the fresh memory store as if current.
    expect(ids(loaded.data)).toEqual(["a", "b"]);
    expect(loaded.savedAt).toBeUndefined();
    expect(pulls).toBe(2);
    expect(
      (await secondary.read(scope)).transactions.map(({ id }) => id),
    ).toEqual(["a", "b"]);
  });
});
