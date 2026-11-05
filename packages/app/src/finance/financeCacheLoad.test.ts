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
  organizationId: "org",
  userId: "person",
  transactions: [],
};

function feed(...ids: string[]): FinanceTransactionChanges {
  return {
    cursor: "1",
    more: false,
    organizationId: "org",
    userId: "person",
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

  it("clears at once on a refusal while the other request still waits", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    const stalled = Promise.withResolvers<FinanceTransactionChanges>();
    const waited = Bun.sleep(1000).then(() => "still waiting");
    const outcome = await Promise.race([
      loadFinance(store, scope, true, {
        ...sources,
        changes: () => stalled.promise,
        summary: async () => {
          throw failure(403);
        },
      }).then(
        () => "loaded",
        (cause: Error) => cause.message,
      ),
      waited,
    ]);
    expect(outcome).toBe("Status 403.");
    expect((await store.read(scope)).transactions).toEqual([]);
    // The stalled page, arriving later, is not kept.
    stalled.resolve({ ...feed("late"), cursor: "2" });
    await Bun.sleep(0);
    expect((await store.read(scope)).transactions).toEqual([]);
  });

  it("brings a saved copy up to date from pages without transactions", async () => {
    const store = memoryTransactionStore();
    let feeds = 0;
    const counted = {
      ...sources,
      changes: async () => {
        feeds++;
        return feeds === 1
          ? feed("a", "b")
          : { ...feed(), cursor: "2", removedIds: ["a"] };
      },
    };
    // Without a saved copy, Categories and Connections read no transactions.
    await loadFinance(store, scope, false, counted);
    expect(feeds).toBe(0);
    await loadFinance(store, scope, true, counted);
    // Deleting a bank's data from Connections reaches the saved copy.
    const connections = await loadFinance(store, scope, false, counted);
    expect(connections.data.transactions).toEqual([]);
    expect(feeds).toBe(2);
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "b",
    ]);
    // Nor does it save a summary for a scope without a saved copy.
    const fresh = memoryTransactionStore();
    await loadFinance(fresh, scope, false, counted);
    expect((await fresh.read(scope)).summary).toBeNull();
    // Their changes to categories reach the saved copy's summary.
    const renamed = {
      ...summary,
      categories: [
        { id: "meals", name: "Dining", slug: "dining", transactionCount: 0 },
      ],
    };
    await loadFinance(store, scope, false, {
      ...counted,
      summary: async () => renamed,
    });
    expect((await store.read(scope)).summary?.categories).toEqual(
      renamed.categories,
    );
    // An outage of the feed alone does not fail those pages.
    const offline = await loadFinance(store, scope, false, {
      ...counted,
      changes: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(offline.data.organizationId).toBe("org");
  });

  it("catches up a saved copy that finished empty from other pages", async () => {
    const store = memoryTransactionStore();
    let feeds = 0;
    const counted = {
      ...sources,
      changes: async () => {
        feeds++;
        // Before any bank import the feed ends with no cursor.
        return feeds === 1 ? { ...feed(), cursor: null } : feed("a");
      },
    };
    await loadFinance(store, scope, true, counted);
    await loadFinance(store, scope, false, counted);
    expect(feeds).toBe(2);
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "a",
    ]);
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

  it("ends at once when the feed finds another account while the summary stalls", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    const stalled = new Promise<FinanceData>(() => {});
    const waited = Bun.sleep(1000).then(() => "still waiting");
    const outcome = await Promise.race([
      loadFinance(store, scope, true, {
        ...sources,
        changes: async () => ({ ...feed("theirs"), userId: "someone-else" }),
        summary: () => stalled,
      }).then(
        () => "loaded",
        (cause: Error) => cause.message,
      ),
      waited,
    ]);
    expect(outcome).toContain("The signed-in account or organization changed");
    // The copy is this person's still; another session's answer clears nothing.
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("saves nothing read in another account's session", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    const before = await store.read(scope);
    await expect(
      loadFinance(store, scope, true, {
        ...sources,
        summary: async () => ({ ...summary, userId: "someone-else" }),
      }),
    ).rejects.toThrow("The signed-in account or organization changed");
    expect((await store.read(scope)).summary).toEqual(before.summary);
  });

  it("saves nothing when either response is another organization's", async () => {
    const store = memoryTransactionStore();
    await loadFinance(store, scope, true, sources);
    const before = await store.read(scope);
    await expect(
      loadFinance(store, scope, true, {
        ...sources,
        summary: async () => ({ ...summary, organizationId: "other" }),
      }),
    ).rejects.toThrow("The signed-in account or organization changed");
    await expect(
      loadFinance(store, scope, true, {
        ...sources,
        changes: async () => ({ ...feed("c"), organizationId: "other" }),
        summary: async () => ({
          ...summary,
          accounts: [
            {
              availableBalance: null,
              currencyCode: "USD",
              currentBalance: 1,
              id: "theirs",
              institutionName: null,
              mask: null,
              name: "Theirs",
              officialName: null,
              subtype: null,
              type: "depository",
            },
          ],
        }),
      }),
    ).rejects.toThrow("The signed-in account or organization changed");
    // Neither the other organization's rows nor this load's summary.
    const after = await store.read(scope);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.summary).toEqual(before.summary);
  });

  it("lets a retry after a clearing finish while the pull it overtook ends", async () => {
    const store = memoryTransactionStore();
    const stalled = Promise.withResolvers<FinanceTransactionChanges>();
    const asked = Promise.withResolvers<void>();
    let calls = 0;
    const changes = () => {
      calls++;
      if (calls > 1) return Promise.resolve(feed("fresh"));
      asked.resolve();
      return stalled.promise;
    };
    const first = loadFinance(store, scope, true, { ...sources, changes });
    await asked.promise;
    // Access ended elsewhere; then a retry starts, behind the first pull.
    await store.clear(scope);
    const retry = loadFinance(store, scope, true, { ...sources, changes });
    stalled.resolve(feed("stale"));
    await expect(first).rejects.toBeInstanceOf(SignedOut);
    expect(ids((await retry).data)).toEqual(["fresh"]);
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
    const store = fallBack(failing, secondary);
    let pulls = 0;
    const loaded = await loadFinance(store, scope, true, {
      ...sources,
      changes: async () => {
        pulls++;
        return feed("a", "b");
      },
    });
    // Not an empty list read from the fresh memory store as if current.
    expect(ids(loaded.data)).toEqual(["a", "b"]);
    expect(loaded.savedAt).toBeUndefined();
    expect(pulls).toBe(2);
    expect(
      (await secondary.read(scope)).transactions.map(({ id }) => id),
    ).toEqual(["a", "b"]);
    // A refusal after the fallback clears what IndexedDB still keeps too.
    expect((await primary.read(scope)).transactions).toHaveLength(2);
    await expect(
      loadFinance(store, scope, true, {
        ...sources,
        changes: async () => {
          throw failure(403);
        },
      }),
    ).rejects.toThrow("Status 403.");
    expect((await primary.read(scope)).transactions).toEqual([]);
    expect((await secondary.read(scope)).transactions).toEqual([]);
  });
});
