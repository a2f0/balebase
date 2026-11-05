import { describe, expect, it } from "bun:test";
import type {
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import {
  type CacheScope,
  memoryTransactionStore,
  pullTransactions,
} from "./transactionCache";

const scope: CacheScope = { organizationId: "org", userId: "person" };

function row(id: string, amount = 1): FinanceTransaction {
  return {
    accountId: "account",
    accountName: "Checking",
    amount,
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

function page(
  cursor: string,
  more: boolean,
  transactions: FinanceTransaction[],
  removedIds: string[] = [],
): FinanceTransactionChanges {
  return {
    cursor,
    more,
    organizationId: "org",
    removedIds,
    reset: false,
    transactions,
  };
}

/** A feed of fixed pages keyed by the cursor each follows. */
function feed(pages: Record<string, FinanceTransactionChanges>) {
  const requested: (string | null)[] = [];
  const fetchPage = async (cursor: string | null) => {
    requested.push(cursor);
    const found = pages[cursor ?? "start"];
    if (!found) throw new Error(`No page after ${cursor}`);
    return found;
  };
  return { fetchPage, requested };
}

describe("pulling transactions", () => {
  it("resumes from the last saved page after an interrupted download", async () => {
    const store = memoryTransactionStore();
    let fail = true;
    const pages = feed({
      start: page("1", true, [row("a"), row("b")]),
      "1": page("2", false, [row("c"), row("a", 5)], ["b"]),
    });
    const interrupted = async (cursor: string | null) => {
      if (cursor === "1" && fail) {
        fail = false;
        throw new TypeError("Failed to fetch");
      }
      return pages.fetchPage(cursor);
    };
    await expect(pullTransactions(scope, store, interrupted)).rejects.toThrow(
      "Failed to fetch",
    );
    // The first page and its cursor were kept; nothing is complete yet.
    const partial = await store.read(scope);
    expect(partial.cursor).toBe("1");
    expect(partial.completedAt).toBeNull();
    expect(partial.transactions.map(({ id }) => id)).toEqual(["a", "b"]);

    await pullTransactions(scope, store, interrupted);
    // The retry asked for the page after the saved cursor, not the start.
    expect(pages.requested).toEqual([null, "1"]);
    const done = await store.read(scope);
    expect(done.cursor).toBe("2");
    expect(done.completedAt).not.toBeNull();
    expect(
      done.transactions.map(({ amount, id }) => [id, amount]).sort(),
    ).toEqual([
      ["a", 5],
      ["c", 1],
    ]);
  });

  it("shares one pull per scope and re-reads the cursor after another writer moves it", async () => {
    const store = memoryTransactionStore();
    const pages = feed({
      start: page("1", false, [row("a")]),
      "1": page("2", false, [row("b")]),
      "2": page("3", false, [row("c")]),
    });
    const [first, second] = [
      pullTransactions(scope, store, pages.fetchPage),
      pullTransactions(scope, store, pages.fetchPage),
    ];
    expect(first).toBe(second);
    await first;
    expect(pages.requested).toEqual([null]);

    // Another tab applies the next page while this pull's request is out.
    const racing = async (cursor: string | null) => {
      const answer = await pages.fetchPage(cursor);
      if (cursor === "1" && pages.requested.length === 2) {
        await store.apply(
          scope,
          { cursor: "1", epoch: "0" },
          page("2", false, [row("b")]),
          "now",
        );
      }
      return answer;
    };
    await pullTransactions(scope, store, racing);
    // Its page was refused (the cursor moved), so it read on from the new one.
    expect(pages.requested).toEqual([null, "1", "2"]);
    const kept = await store.read(scope);
    expect(kept.cursor).toBe("3");
    expect(kept.transactions.map(({ id }) => id).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("shares a pull only with the same store", async () => {
    const pages = feed({ start: page("1", false, [row("a")]) });
    const [first, second] = [
      memoryTransactionStore(),
      memoryTransactionStore(),
    ];
    await Promise.all([
      pullTransactions(scope, first, pages.fetchPage),
      pullTransactions(scope, second, pages.fetchPage),
    ]);
    expect(pages.requested).toEqual([null, null]);
    expect((await second.read(scope)).transactions.map(({ id }) => id)).toEqual(
      ["a"],
    );
  });

  it("starts over once when the server is behind the device, and refuses other organizations", async () => {
    const store = memoryTransactionStore();
    await store.apply(
      scope,
      { cursor: null, epoch: "0" },
      page("9", false, [row("stale")]),
      "then",
    );
    const pages = feed({
      "9": { ...page("", false, []), cursor: null, reset: true },
      start: page("1", false, [row("fresh")]),
    });
    await pullTransactions(scope, store, pages.fetchPage);
    expect(pages.requested).toEqual(["9", null]);
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "fresh",
    ]);

    const elsewhere = async () => ({
      ...page("5", false, [row("other")]),
      organizationId: "another-org",
    });
    await expect(pullTransactions(scope, store, elsewhere)).rejects.toThrow(
      "The active organization changed",
    );
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "fresh",
    ]);
  });
});
