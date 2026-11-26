import { describe, expect, it, spyOn } from "bun:test";
import { ApiError } from "@balebase/api-client";
import type {
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { type CacheScope, SignedOut } from "../../data/finance/financeCache";
import { FinanceCache } from ".";

const apiUrl = "https://api.test";
const cache = new FinanceCache(apiUrl);

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
    const store = cache.memoryStore();
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
    await expect(cache.pull(scope, store, interrupted)).rejects.toThrow(
      "Failed to fetch",
    );
    // The first page and its cursor were kept; nothing is complete yet.
    const partial = await store.read(scope);
    expect(partial.cursor).toBe("1");
    expect(partial.completedAt).toBeNull();
    expect(partial.transactions.map(({ id }) => id)).toEqual(["a", "b"]);

    await cache.pull(scope, store, interrupted);
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
    const store = cache.memoryStore();
    const pages = feed({
      start: page("1", false, [row("a")]),
      "1": page("2", false, [row("a", 7)]),
    });
    const first = cache.pull(scope, store, pages.fetchPage);
    // A save committed while the first pull runs: its callers must see it.
    const [second, third] = [
      cache.pull(scope, store, pages.fetchPage),
      cache.pull(scope, store, pages.fetchPage),
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
    const store = cache.memoryStore();
    const held = Promise.withResolvers<FinanceTransactionChanges>();
    const first = cache.pull(scope, store, () => held.promise);
    const queued = cache.pull(scope, store, async () =>
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
    const store = cache.memoryStore();
    const pages = feed({
      start: page("1", false, [row("a")]),
      "1": page("2", false, [row("b")]),
      "2": page("3", false, [row("c")]),
    });
    await cache.pull(scope, store, pages.fetchPage);
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
    await cache.pull(scope, store, racing);
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
    const store = cache.memoryStore();
    await cache.pull(scope, store, async () => page("1", false, [row("a")]));
    await cache.catchUp(
      scope,
      async () => {
        throw new TypeError("Failed to fetch");
      },
      store,
    );
    expect((await store.read(scope)).transactions).toHaveLength(1);
    // A refusal clears it and is reported, so the page clears too.
    await expect(
      cache.catchUp(
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
    await expect(
      cache.clearedOnRefusal(scope, status(503), clear),
    ).rejects.toThrow();
    expect(
      await cache.clearedOnRefusal(scope, Promise.resolve("record"), clear),
    ).toBe("record");
    await expect(
      cache.clearedOnRefusal(undefined, status(403), clear),
    ).rejects.toThrow();
    // Ended by a clearing already: not cleared again.
    await expect(
      cache.clearedOnRefusal(scope, Promise.reject(new SignedOut()), clear),
    ).rejects.toBeInstanceOf(SignedOut);
    expect(cleared).toEqual([]);
    await expect(
      cache.clearedOnRefusal(scope, status(403), clear),
    ).rejects.toThrow("Request failed with status 403.");
    expect(cleared).toEqual([scope]);
  });

  it("tells other tabs about every clearing", async () => {
    const heard: unknown[] = [];
    const listener = new BroadcastChannel("balebase-finance-cleared");
    listener.onmessage = (event) => {
      const { except, organizationId, userId } = event.data;
      heard.push({ except, organizationId, userId });
    };
    await cache.clearScope(scope);
    await cache.clearFormerOrganizations("person", ["org"]);
    await cache.clearUser("person");
    // A tab clearing because another told it does not tell the rest again.
    await cache.clearScope(scope, false);
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
    const stop = cache.onCleared(({ except, organizationId, userId }) => {
      heard.push({ except, organizationId, userId });
      if (organizationId === undefined) fromOtherTab.resolve();
    });
    await cache.clearScope(scope);
    // A copy only this tab keeps, without IndexedDB.
    await cache.memoryStore().clear({
      ...scope,
      organizationId: "memory",
    });
    const otherTab = new BroadcastChannel("balebase-finance-cleared");
    otherTab.postMessage({ apiUrl, source: "other-tab", userId: "person" });
    await fromOtherTab.promise;
    otherTab.close();
    stop();
    expect(heard).toEqual([
      { except: undefined, organizationId: "org", userId: "person" },
      { except: undefined, organizationId: "memory", userId: "person" },
      { except: undefined, organizationId: undefined, userId: "person" },
    ]);
  });

  it("shares this tab's listeners between caches for one API only", async () => {
    const heard: string[] = [];
    const last = Promise.withResolvers<void>();
    const stop = cache.onCleared(({ organizationId }) => {
      if (organizationId) heard.push(organizationId);
      if (organizationId === "last") last.resolve();
    });
    // A second SDK for the API, as after a host change, reaches them.
    await new FinanceCache(apiUrl)
      .memoryStore()
      .clear({ ...scope, organizationId: "same-api" });
    await new FinanceCache("https://other.test")
      .memoryStore()
      .clear({ ...scope, organizationId: "other-api" });
    // Another API's announcements from other tabs do not either; one
    // channel delivers in order, so hearing "last" means the first arrived.
    const otherTab = new BroadcastChannel("balebase-finance-cleared");
    for (const [api, organizationId] of [
      ["https://other.test", "other-tab"],
      [apiUrl, "last"],
    ])
      otherTab.postMessage({
        apiUrl: api,
        organizationId,
        source: "other-tab",
        userId: "person",
      });
    await last.promise;
    otherTab.close();
    stop();
    expect(heard).toEqual(["same-api", "last"]);
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
    const store = cache.memoryStore();
    const stalled = cache.pull(scope, store, () => new Promise(() => {}));
    // A later load queues behind the stalled pull.
    const later = cache.pull(scope, store, async () =>
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
    const [first, second] = [cache.memoryStore(), cache.memoryStore()];
    await Promise.all([
      cache.pull(scope, first, pages.fetchPage),
      cache.pull(scope, second, pages.fetchPage),
    ]);
    expect(pages.requested).toEqual([null, null]);
    expect((await second.read(scope)).transactions.map(({ id }) => id)).toEqual(
      ["a"],
    );
  });

  it("starts over once when the server is behind the device, and refuses other organizations", async () => {
    const store = cache.memoryStore();
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
    await cache.pull(scope, store, pages.fetchPage);
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
      await expect(cache.pull(scope, store, answer)).rejects.toThrow(
        "The signed-in account or organization changed",
      );
    expect((await store.read(scope)).transactions.map(({ id }) => id)).toEqual([
      "fresh",
    ]);
  });
});
