import { describe, expect, it, spyOn } from "bun:test";
import { ApiError } from "@balebase/api-client";
import type {
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { apiUrl } from "../shared/config";
import {
  type CacheScope,
  catchUpSavedTransactions,
  clearedOnRefusal,
  clearFormerOrganizations,
  clearScopeTransactions,
  clearUserTransactions,
  memoryTransactionStore,
  onCleared,
  pullTransactions,
  SignedOut,
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
    userId: "person",
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

  it("reads again after a running pull for callers who arrive during it", async () => {
    const store = memoryTransactionStore();
    const pages = feed({
      start: page("1", false, [row("a")]),
      "1": page("2", false, [row("a", 7)]),
    });
    const first = pullTransactions(scope, store, pages.fetchPage);
    // A save committed while the first pull runs: its callers must see it.
    const [second, third] = [
      pullTransactions(scope, store, pages.fetchPage),
      pullTransactions(scope, store, pages.fetchPage),
    ];
    expect(second).toBe(third);
    expect(second).not.toBe(first);
    await second;
    expect(pages.requested).toEqual([null, "1"]);
    expect(
      (await store.read(scope)).transactions.map(({ amount }) => amount),
    ).toEqual([7]);
  });

  it("ends a queued pull whose saved copy was cleared before it started", async () => {
    const store = memoryTransactionStore();
    const held = Promise.withResolvers<FinanceTransactionChanges>();
    const first = pullTransactions(scope, store, () => held.promise);
    const queued = pullTransactions(scope, store, async () =>
      page("1", false, [row("queued")]),
    );
    // Access ends (or the person signs out) while both wait.
    await store.clear(scope);
    held.resolve(page("1", false, [row("first")]));
    const outcome = (work: Promise<void>) =>
      work.then(
        () => "kept",
        (cause: Error) => cause.message,
      );
    expect(await Promise.all([outcome(first), outcome(queued)])).toEqual([
      "Saved transactions were cleared. Reload Finance.",
      "Saved transactions were cleared. Reload Finance.",
    ]);
    expect((await store.read(scope)).transactions).toEqual([]);
  });

  it("re-reads the cursor after another writer moves it", async () => {
    const store = memoryTransactionStore();
    const pages = feed({
      start: page("1", false, [row("a")]),
      "1": page("2", false, [row("b")]),
      "2": page("3", false, [row("c")]),
    });
    await pullTransactions(scope, store, pages.fetchPage);
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

  it("catches a saved copy up, keeping it through outages and nothing after a refusal", async () => {
    const store = memoryTransactionStore();
    await pullTransactions(scope, store, async () =>
      page("1", false, [row("a")]),
    );
    await catchUpSavedTransactions(
      scope,
      async () => {
        throw new TypeError("Failed to fetch");
      },
      store,
    );
    expect((await store.read(scope)).transactions).toHaveLength(1);
    // A refusal clears it and is reported, so the page clears too.
    await expect(
      catchUpSavedTransactions(
        scope,
        async () => {
          throw new ApiError(new Response(null, { status: 403 }), null);
        },
        store,
      ),
    ).rejects.toThrow("Request failed with status 403.");
    expect((await store.read(scope)).transactions).toEqual([]);
  });

  it("clears the saved copy when a record page is refused, and only then", async () => {
    const cleared: CacheScope[] = [];
    const clear = async (which: CacheScope) => {
      cleared.push(which);
    };
    const status = (code: number) =>
      Promise.reject(new ApiError(new Response(null, { status: code }), null));
    await expect(clearedOnRefusal(scope, status(503), clear)).rejects.toThrow();
    expect(
      await clearedOnRefusal(scope, Promise.resolve("record"), clear),
    ).toBe("record");
    await expect(
      clearedOnRefusal(undefined, status(403), clear),
    ).rejects.toThrow();
    // Ended by a clearing already: not cleared again.
    await expect(
      clearedOnRefusal(scope, Promise.reject(new SignedOut()), clear),
    ).rejects.toBeInstanceOf(SignedOut);
    expect(cleared).toEqual([]);
    await expect(clearedOnRefusal(scope, status(403), clear)).rejects.toThrow(
      "Request failed with status 403.",
    );
    expect(cleared).toEqual([scope]);
  });

  it("tells other tabs about every clearing", async () => {
    const heard: unknown[] = [];
    const listener = new BroadcastChannel("balebase-finance-cleared");
    listener.onmessage = (event) => {
      const { except, organizationId, userId } = event.data;
      heard.push({ except, organizationId, userId });
    };
    await clearScopeTransactions(scope);
    await clearFormerOrganizations("person", ["org"]);
    await clearUserTransactions("person");
    // A tab clearing because another told it does not tell the rest again.
    await clearScopeTransactions(scope, false);
    await Bun.sleep(5);
    listener.close();
    expect(heard).toEqual([
      { except: undefined, organizationId: "org", userId: "person" },
      { except: ["org"], organizationId: undefined, userId: "person" },
      { except: undefined, organizationId: undefined, userId: "person" },
    ]);
  });

  it("tells this tab's listeners about clearings here and in other tabs", async () => {
    const heard: unknown[] = [];
    const fromOtherTab = Promise.withResolvers<void>();
    const stop = onCleared(({ except, organizationId, userId }) => {
      heard.push({ except, organizationId, userId });
      if (organizationId === undefined) fromOtherTab.resolve();
    });
    await clearScopeTransactions(scope);
    const otherTab = new BroadcastChannel("balebase-finance-cleared");
    otherTab.postMessage({ apiUrl, source: "other-tab", userId: "person" });
    await fromOtherTab.promise;
    otherTab.close();
    stop();
    expect(heard).toEqual([
      { except: undefined, organizationId: "org", userId: "person" },
      { except: undefined, organizationId: undefined, userId: "person" },
    ]);
  });

  it("gives up on a stalled page so pulls waiting behind it can run", async () => {
    // Holds the page timeout (only) until fired below.
    const timeouts: (() => void)[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      if (delay !== 60_000) return realSetTimeout(handler, delay);
      timeouts.push(handler);
      return 0;
    }) as unknown as typeof setTimeout);
    const store = memoryTransactionStore();
    const stalled = pullTransactions(scope, store, () => new Promise(() => {}));
    // A later load queues behind the stalled pull.
    const later = pullTransactions(scope, store, async () =>
      page("1", false, [row("a")]),
    );
    await Bun.sleep(0);
    spy.mockRestore();
    for (const fire of timeouts.splice(0)) fire();
    await expect(stalled).rejects.toThrow("timed out");
    await later;
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "a",
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
    // Another tab signed in as someone else in the same organization.
    const someoneElse = async () => ({
      ...page("5", false, [row("theirs")]),
      userId: "someone-else",
    });
    for (const answer of [elsewhere, someoneElse])
      await expect(pullTransactions(scope, store, answer)).rejects.toThrow(
        "The signed-in account or organization changed",
      );
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "fresh",
    ]);
  });
});
