import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import type {
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { type Browser, launch, type Page } from "puppeteer-core";
import {
  chromeLaunchOptions,
  closeChrome,
} from "../../../scripts/testing/chrome";
import type {} from "./transactionCacheFixture";

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

const scope = { organizationId: "org", userId: "person" };

async function kept(target: Page, of = scope) {
  return target.evaluate(async (which) => {
    const saved = await window.transactionCacheTest?.store.read(which);
    return {
      completed: Boolean(saved?.completedAt),
      cursor: saved?.cursor,
      rows: saved?.transactions
        .map(({ amount, id }) => `${id}:${amount}`)
        .sort(),
    };
  }, of);
}

it("keeps transactions in IndexedDB a page at a time, across reloads and interruptions", async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./transactionCacheFixture.ts", import.meta.url)),
    ],
    define: { "import.meta.env": "{}" },
    target: "browser",
  });
  const source = await bundle.outputs[0]?.text();
  if (!bundle.success || !source)
    throw new Error(`Fixture did not bundle: ${bundle.logs.join("\n")}`);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/fixture.js"
        ? new Response(source, {
            headers: { "content-type": "text/javascript" },
          })
        : new Response('<!doctype html><script src="/fixture.js"></script>', {
            headers: { "content-type": "text/html" },
          });
    },
  });
  let browser: Browser | undefined;
  try {
    browser = await launch(chromeLaunchOptions());
    const target = await browser.newPage();
    await target.goto(server.url.href);
    await target.waitForFunction(() => Boolean(window.transactionCacheTest));

    // A page applies with its cursor; a page from a stale cursor does not.
    const applied = await target.evaluate(
      async (who, first, stale) => {
        const store = window.transactionCacheTest?.store;
        return [
          await store?.apply(who, { cursor: null, epoch: ":" }, first, "t1"),
          await store?.apply(who, { cursor: null, epoch: ":" }, stale, "t2"),
        ];
      },
      scope,
      page("1", true, [row("a"), row("b")]),
      page("x", false, [row("stale")]),
    );
    expect(applied).toEqual([true, false]);
    expect(await kept(target)).toEqual({
      completed: false,
      cursor: "1",
      rows: ["a:1", "b:1"],
    });

    // A page that cannot be stored leaves nothing of itself behind.
    const failed = await target.evaluate(async (who) => {
      const broken = {
        cursor: "2",
        more: false,
        organizationId: "org",
        removedIds: ["a"],
        reset: false,
        transactions: [{ id: "c", amount: 1, bad: () => undefined }],
      } as unknown as FinanceTransactionChanges;
      try {
        await window.transactionCacheTest?.store.apply(
          who,
          { cursor: "1", epoch: ":" },
          broken,
          "t3",
        );
        return "stored";
      } catch (cause) {
        return (cause as Error).name;
      }
    }, scope);
    expect(failed).toBe("DataCloneError");
    expect(await kept(target)).toEqual({
      completed: false,
      cursor: "1",
      rows: ["a:1", "b:1"],
    });

    // Closing the tab mid-download keeps what was saved; the next pull
    // resumes from its cursor.
    await target.reload();
    await target.waitForFunction(() => Boolean(window.transactionCacheTest));
    const requested = await target.evaluate(
      async (who, next) => {
        const asked: (string | null)[] = [];
        await window.transactionCacheTest?.pullTransactions(
          who,
          window.transactionCacheTest.store,
          async (cursor) => {
            asked.push(cursor);
            return next;
          },
        );
        return asked;
      },
      scope,
      page("2", false, [row("a", 5), row("c")], ["b"]),
    );
    expect(requested).toEqual(["1"]);
    expect(await kept(target)).toEqual({
      completed: true,
      cursor: "2",
      rows: ["a:5", "c:1"],
    });

    // Signing out drops the person's saved transactions in every
    // organization and keeps another account's.
    const others = [
      { organizationId: "other-org", userId: "person" },
      { organizationId: "org", userId: "someone-else" },
    ];
    await target.evaluate(
      async (scopes, data) => {
        for (const which of scopes)
          await window.transactionCacheTest?.store.apply(
            which,
            { cursor: null, epoch: ":" },
            data,
            "t4",
          );
        await window.transactionCacheTest?.clearUserTransactions("person");
      },
      others,
      page("9", false, [row("z")]),
    );
    expect(await kept(target)).toEqual({
      completed: false,
      cursor: null,
      rows: [],
    });
    expect((await kept(target, others[0])).rows).toEqual([]);
    expect((await kept(target, others[1])).rows).toEqual(["z:1"]);

    // A page that arrives after signing out (here, a slow first page) is
    // not kept, even from a pull that started before.
    const late = await target.evaluate(
      async (who, data) => {
        const cache = window.transactionCacheTest;
        if (!cache) throw new Error("No fixture");
        const answer = Promise.withResolvers<FinanceTransactionChanges>();
        const asked = Promise.withResolvers<void>();
        const pull = cache.pullTransactions(who, cache.store, () => {
          asked.resolve();
          return answer.promise;
        });
        await asked.promise;
        await cache.clearUserTransactions("person");
        answer.resolve(data);
        return pull.then(
          () => "kept",
          (cause: Error) => cause.message,
        );
      },
      scope,
      page("3", false, [row("late")]),
    );
    expect(late).toBe("Saved transactions were cleared. Reload Finance.");

    // Nor does a pull that saved pages before the sign-out carry on with
    // the epoch the sign-out set.
    const resumed = await target.evaluate(
      async (who, first, second) => {
        const cache = window.transactionCacheTest;
        if (!cache) throw new Error("No fixture");
        let clearing: Promise<void> | undefined;
        const asked: (string | null)[] = [];
        const reply = await cache
          .pullTransactions(
            who,
            cache.store,
            async (cursor) => {
              asked.push(cursor);
              if (asked.length === 1) return first;
              await clearing;
              return second;
            },
            // Signs out once the first page is saved, before the next is
            // asked for.
            () => {
              clearing ??= cache.clearUserTransactions("person");
            },
          )
          .then(
            () => "kept",
            (cause: Error) => cause.message,
          );
        return { asked, reply };
      },
      scope,
      page("4", true, [row("early")]),
      page("5", false, [row("after")]),
    );
    expect(resumed.reply).toBe(
      "Saved transactions were cleared. Reload Finance.",
    );
    expect((await kept(target)).rows).toEqual([]);
    expect(await kept(target)).toEqual({
      completed: false,
      cursor: null,
      rows: [],
    });

    // A refusal (here, in another tab) ends a pull still waiting on its first
    // page, and keeps a summary read before it from being saved.
    const refused = await target.evaluate(
      async (who, data, summary) => {
        const cache = window.transactionCacheTest;
        if (!cache) throw new Error("No fixture");
        const { epoch } = await cache.store.position(who);
        const answer = Promise.withResolvers<FinanceTransactionChanges>();
        const asked = Promise.withResolvers<void>();
        const pull = cache.pullTransactions(who, cache.store, () => {
          asked.resolve();
          return answer.promise;
        });
        await asked.promise;
        await cache.store.clear(who);
        answer.resolve(data);
        const outcome = (work: Promise<unknown>) =>
          work.then(
            () => "kept",
            (cause: Error) => cause.message,
          );
        return [
          await outcome(pull),
          await outcome(cache.store.saveSummary(who, summary, epoch)),
        ];
      },
      scope,
      page("6", false, [row("refused")]),
      { accounts: [], categories: [], configured: true, connections: [] },
    );
    expect(refused).toEqual([
      "Saved transactions were cleared. Reload Finance.",
      "Saved transactions were cleared. Reload Finance.",
    ]);
    expect(await kept(target)).toEqual({
      completed: false,
      cursor: null,
      rows: [],
    });
    const summaryKept = await target.evaluate(
      async (who) =>
        (await window.transactionCacheTest?.store.read(who))?.summary ?? null,
      scope,
    );
    expect(summaryKept).toBeNull();
  } finally {
    await closeChrome(browser);
    await server.stop(true);
  }
}, 60_000);
