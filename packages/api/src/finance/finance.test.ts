import { describe, expect, it } from "bun:test";
import {
  createCategory,
  createFixture,
  type FinanceListing,
  financePath,
  jsonRequest,
  mockPlaid,
  seedTransactions,
  testApp,
} from "../testing/financeFixture";
import type { Bindings } from "../types";
import {
  PlaidApiError,
  type PlaidRequest,
  type PlaidRequestBody,
} from "./plaid";

describe("finance", () => {
  it("filters the full history by multiple accounts and calendar year before paging", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const db = fixture.database;
    db.run(`INSERT INTO plaid_accounts
      (id, plaid_account_id, organization_id, plaid_item_record_id, name, type, updated_at)
      VALUES ('account-second', 'plaid-second', 'org_user-1', 'item-report', 'Savings', 'depository', '2026-01-01')`);
    db.run(
      "UPDATE plaid_transactions SET transaction_date = '2025-01-01' WHERE id = 'report-txn-0'",
    );
    db.run(
      "UPDATE plaid_transactions SET transaction_date = '2025-12-31', account_record_id = 'account-second' WHERE id = 'report-txn-1'",
    );
    db.run(
      "UPDATE plaid_transactions SET transaction_date = '2024-12-31' WHERE id = 'report-txn-2'",
    );
    for (let index = 0; index < 260; index++) {
      db.query(`INSERT INTO plaid_transactions
        (id, plaid_transaction_id, organization_id, plaid_item_record_id, account_record_id,
         name, amount, transaction_date, pending, source_status, updated_at)
        VALUES (?, ?, 'org_user-1', 'item-report', 'account-report', 'Recent expense', 1,
                '2026-01-01', 0, 'active', '2026-01-01')`).run(
        `recent-${index}`,
        `plaid-recent-${index}`,
      );
    }
    const list = (query: string) =>
      jsonRequest<FinanceListing>(fixture.app, fixture.bindings, query, "GET");
    const prior = await list(
      "?year=2025&accountId=account-report&accountId=account-second&uncategorized=true",
    );
    expect(prior.body.transactions.map((txn) => txn.id)).toEqual([
      "report-txn-1",
      "report-txn-0",
    ]);
    expect(prior.body.nextCursor).toBeNull();
    const single = await list("?year=2025&accountId=account-second");
    expect(single.body.transactions.map((txn) => txn.id)).toEqual([
      "report-txn-1",
    ]);
    const missing = await list("?accountId=unknown");
    expect(missing.body.transactions).toEqual([]);
    const first = await list("?year=2026");
    expect(first.body.transactions).toHaveLength(250);
    expect(first.body.nextCursor).toBeString();
    const second = await list(
      `?year=2026&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    expect(second.body.nextCursor).toBeNull();
    expect(second.body.transactions).toHaveLength(18);
    const legacyCursor = JSON.stringify({
      date: "2026-01-01",
      id: first.body.transactions.at(-1)?.id,
    });
    const legacyPage = await list(
      `?year=2026&cursor=${encodeURIComponent(legacyCursor)}`,
    );
    expect(legacyPage.body.transactions).toEqual(second.body.transactions);
    expect(
      new Set(
        [...first.body.transactions, ...second.body.transactions].map(
          (txn) => txn.id,
        ),
      ).size,
    ).toBe(268);
    const hidden = await jsonRequest<FinanceListing>(
      testApp("organization-2", fixture.requestPlaid),
      fixture.bindings,
      `?year=2026&accountId=account-report&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
      "GET",
    );
    expect(hidden.body.transactions).toEqual([]);
  });

  it("finds uncategorized expenses using the report rules and reflects category changes", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const categoryId = await createCategory(fixture, "Meals");
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/transactions/report-txn-0/category",
      "PUT",
      { categoryId },
    );
    fixture.database.run(
      "UPDATE plaid_transactions SET category_primary = NULL WHERE id = 'report-txn-1'",
    );
    const listing = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "?year=2026&uncategorized=true",
      "GET",
    );
    expect(listing.body.transactions.map((txn) => txn.id)).toEqual([
      "report-txn-10",
      "report-txn-3",
      "report-txn-1",
      "report-txn-9",
    ]);
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/transactions/report-txn-0/category",
      "PUT",
      { categoryId: null },
    );
    const cleared = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "?uncategorized=true",
      "GET",
    );
    expect(cleared.body.transactions.map((txn) => txn.id)).toContain(
      "report-txn-0",
    );
  });

  it("lists one expense category's transactions across the full history", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const meals = await createCategory(fixture, "Meals");
    const software = await createCategory(fixture, "Software");
    for (const [id, categoryId] of [
      ["report-txn-0", meals],
      ["report-txn-2", meals],
      ["report-txn-1", software],
    ]) {
      await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${id}/category`,
        "PUT",
        { categoryId },
      );
    }
    fixture.database.run(
      "UPDATE plaid_transactions SET transaction_date = '2024-06-01' WHERE id = 'report-txn-2'",
    );
    const list = (query: string) =>
      jsonRequest<FinanceListing>(fixture.app, fixture.bindings, query, "GET");

    const all = await list("?category=meals");
    expect(all.body.transactions.map((txn) => txn.id)).toEqual([
      "report-txn-0",
      "report-txn-2",
    ]);
    const year = await list("?category=meals&year=2024");
    expect(year.body.transactions.map((txn) => txn.id)).toEqual([
      "report-txn-2",
    ]);
    const byId = await list(`?categoryId=${meals}`);
    expect(byId.body.transactions.map((txn) => txn.id)).toEqual([
      "report-txn-0",
      "report-txn-2",
    ]);
    const unknown = await list("?category=dining");
    expect(unknown.status).toBe(200);
    expect(unknown.body.transactions).toEqual([]);
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    await createCategory({ ...fixture, app: otherOrganization }, "Meals");
    const hidden = await jsonRequest<FinanceListing>(
      otherOrganization,
      fixture.bindings,
      "?category=meals",
      "GET",
    );
    expect(hidden.body.transactions).toEqual([]);
  });

  it("rejects malformed transaction filters", async () => {
    const fixture = await createFixture();
    for (const query of [
      "year=nope",
      "year=2025-01-01",
      "accountId=",
      "uncategorized=false",
      "category=",
      "categoryId=",
      "cursor=broken",
      "cursor=null",
    ]) {
      const result = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `?${query}`,
        "GET",
      );
      expect(result.status).toBe(400);
    }
  });

  it("rejects malformed exchanges and annotations", async () => {
    const fixture = await createFixture();
    for (const body of [
      {},
      { publicToken: "  " },
      { institutionName: "x".repeat(201), publicToken: "public-sandbox-test" },
      { institutionId: 7, publicToken: "public-sandbox-test" },
    ]) {
      expect(
        await jsonRequest(
          fixture.app,
          fixture.bindings,
          "/exchange",
          "POST",
          body,
        ),
      ).toMatchObject({
        body: { error: "A Plaid public token is required." },
        status: 400,
      });
    }
    const valid = { labels: [], note: "", reviewed: false };
    for (const body of [
      null,
      { ...valid, note: "x".repeat(2001) },
      {
        ...valid,
        labels: Array.from({ length: 13 }, (_, index) => `${index}`),
      },
      { ...valid, labels: ["x".repeat(51)] },
      { ...valid, labels: [7] },
      { ...valid, reviewed: "yes" },
    ]) {
      expect(
        await jsonRequest(
          fixture.app,
          fixture.bindings,
          "/transactions/missing/annotation",
          "PATCH",
          body,
        ),
      ).toMatchObject({
        body: { error: "A valid annotation is required." },
        status: 400,
      });
    }
    expect(
      await jsonRequest(
        fixture.app,
        fixture.bindings,
        "/connections/missing/sync-settings",
        "PATCH",
        { dailySync: "yes" },
      ),
    ).toMatchObject({
      body: { error: "dailySync must be a boolean." },
      status: 400,
    });
  });

  it("links a Plaid connection and imports its transactions", async () => {
    const fixture = await createFixture();
    const linkToken = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/link-token",
      "POST",
    );
    expect(linkToken.status).toBe(200);
    expect(linkToken.body).toEqual({
      expiration: "2026-08-19T12:30:00Z",
      linkToken: "link-sandbox-test",
    });

    const exchange = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    expect(exchange.status).toBe(201);
    const storedToken = fixture.database
      .query(
        `SELECT access_token_ciphertext, organization_id
         FROM plaid_items WHERE id = ?`,
      )
      .get(exchange.body.connectionId) as {
      access_token_ciphertext: string;
      organization_id: string;
    };
    expect(storedToken.organization_id).toBe("org_user-1");
    expect(storedToken.access_token_ciphertext).not.toContain(
      "access-sandbox-test-1",
    );

    const sync = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    expect(sync.status).toBe(200);
    expect(sync.body).toEqual({ added: 1, modified: 0, removed: 0 });

    const listing = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(listing.body.configured).toBe(true);
    expect(listing.body.connections).toMatchObject([
      {
        accountCount: 1,
        institutionName: "First Test Bank",
        status: "active",
      },
    ]);
    expect(listing.body.accounts).toMatchObject([
      { currentBalance: 1250.5, mask: "1234", name: "Checking" },
    ]);
    expect(listing.body.transactions).toMatchObject([
      {
        accountName: "Checking",
        amount: 42.75,
        annotation: {
          labels: [],
          note: "",
          reviewed: false,
        },
        categoryPrimary: "FOOD_AND_DRINK",
        expenseCategoryId: null,
        merchantName: "Test Cafe",
      },
    ]);
    const accountId = listing.body.accounts[0]?.id;
    const transactionId = listing.body.transactions[0]?.id;
    expect(accountId).toBeString();
    expect(transactionId).toBeString();

    const detail = await jsonRequest<{ source: unknown }>(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}`,
      "GET",
    );
    expect(detail.status).toBe(200);
    expect(detail.body.source).toEqual({
      accountMask: "1234",
      accountOfficialName: "Plaid Gold Checking",
      accountSubtype: "checking",
      accountType: "depository",
      institutionName: "First Test Bank",
      pendingTransactionId: null,
      plaidTransactionId: "transaction-test-1",
      updatedAt: expect.any(String),
    });
  });

  it("keeps a connection's history from other organizations", async () => {
    const fixture = await createFixture();
    const { exchange, transactionId } = await importedConnection(fixture);

    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<FinanceListing>(
      otherOrganization,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(hidden.body.connections).toEqual([]);
    expect(hidden.body.transactions).toEqual([]);
    const cannotSync = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    expect(cannotSync.status).toBe(404);
    const cannotRead = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/transactions/${transactionId}`,
      "GET",
    );
    expect(cannotRead.status).toBe(404);
    const cannotAnnotate = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/transactions/${transactionId}/annotation`,
      "PATCH",
      {
        labels: [],
        note: "Not mine",
        reviewed: false,
      },
    );
    expect(cannotAnnotate.status).toBe(404);
  });

  it("keeps annotated history after a disconnect and reconciles it on reconnect", async () => {
    const fixture = await createFixture();
    const { accountId, exchange, transactionId } =
      await importedConnection(fixture);

    const annotated = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/annotation`,
      "PATCH",
      {
        labels: ["reimbursable", "client"],
        note: "Dinner after the site visit.",
        reviewed: true,
      },
    );
    expect(annotated.status).toBe(200);
    const category = await jsonRequest<{ category: { id: string } }>(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "Client meals" },
    );
    expect(category.status).toBe(201);
    const categoryId = category.body.category.id;
    const assigned = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId },
    );
    expect(assigned.status).toBe(200);

    const cannotDeleteActive = await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}/data`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(cannotDeleteActive.status).toBe(409);

    const disconnected = await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnected.status).toBe(204);
    const afterDisconnect = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(afterDisconnect.body.connections).toMatchObject([
      { accountCount: 1, status: "disconnected" },
    ]);
    expect(afterDisconnect.body.accounts[0]?.id).toBe(accountId);
    expect(afterDisconnect.body.transactions[0]).toMatchObject({
      annotation: {
        labels: ["reimbursable", "client"],
        note: "Dinner after the site visit.",
        reviewed: true,
      },
      expenseCategoryId: categoryId,
      id: transactionId,
    });
    const revoked = fixture.database
      .query(
        `SELECT access_token_ciphertext, access_token_iv, status
         FROM plaid_items WHERE id = ?`,
      )
      .get(exchange.body.connectionId) as {
      access_token_ciphertext: string;
      access_token_iv: string;
      status: string;
    };
    expect(revoked).toEqual({
      access_token_ciphertext: "",
      access_token_iv: "",
      status: "disconnected",
    });

    const reconnected = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    expect(reconnected.status).toBe(201);
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${reconnected.body.connectionId}/sync`,
      "POST",
    );
    const afterReconnect = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(afterReconnect.body.connections).toHaveLength(2);
    expect(afterReconnect.body.accounts).toHaveLength(1);
    expect(afterReconnect.body.accounts[0]?.id).toBe(accountId);
    expect(afterReconnect.body.transactions).toHaveLength(1);
    expect(afterReconnect.body.transactions[0]).toMatchObject({
      annotation: {
        labels: ["reimbursable", "client"],
        note: "Dinner after the site visit.",
        reviewed: true,
      },
      expenseCategoryId: categoryId,
      id: transactionId,
    });
  });

  it("deletes the data of archived and current connections", async () => {
    const fixture = await createFixture();
    const { exchange } = await importedConnection(fixture);
    await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    const { exchange: reconnected } = await importedConnection(fixture);

    const deleteArchive = await fixture.app.request(
      financePath(`/connections/${exchange.body.connectionId}/data`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleteArchive.status).toBe(204);
    const disconnectCurrent = await fixture.app.request(
      financePath(`/connections/${reconnected.body.connectionId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnectCurrent.status).toBe(204);
    const deleteCurrent = await fixture.app.request(
      financePath(`/connections/${reconnected.body.connectionId}/data`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleteCurrent.status).toBe(204);
    const afterDelete = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(afterDelete.body.connections).toEqual([]);
    expect(afterDelete.body.accounts).toEqual([]);
    expect(afterDelete.body.transactions).toEqual([]);
  });

  it("details a connection with its accounts, history, and Plaid identifiers", async () => {
    const fixture = await createFixture();
    const plaid = mockPlaid();
    let failSync = false;
    const requestPlaid: PlaidRequest = async <T>(
      env: Bindings,
      path: string,
      body: PlaidRequestBody,
    ) => {
      if (failSync && path === "/transactions/sync") {
        throw new PlaidApiError(
          "The login details of this item have changed.",
          "ITEM_LOGIN_REQUIRED",
          400,
        );
      }
      return plaid<T>(env, path, body);
    };
    const app = testApp("org_user-1", requestPlaid);
    const exchange = await jsonRequest<{ connectionId: string }>(
      app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    const id = exchange.body.connectionId;
    const sync = () =>
      jsonRequest(app, fixture.bindings, `/connections/${id}/sync`, "POST");
    const detail = () =>
      jsonRequest<ConnectionDetail>(
        app,
        fixture.bindings,
        `/connections/${id}`,
        "GET",
      );
    expect((await sync()).status).toBe(200);

    const synced = await detail();
    expect(synced.status).toBe(200);
    expect(synced.body.connection).toMatchObject({
      createdBy: { email: "person@example.com", name: "Example Person" },
      disconnectedAt: null,
      errorCode: null,
      errorMessage: null,
      id,
      institutionId: "ins_test",
      institutionName: "First Test Bank",
      plaidItemId: "item-sandbox-test-1",
      status: "active",
      transactions: {
        count: 1,
        firstDate: "2026-08-19",
        lastDate: "2026-08-19",
      },
    });
    expect(synced.body.connection.lastSyncedAt).toBeString();
    expect(synced.body.accounts).toEqual([
      {
        availableBalance: 1200,
        currencyCode: "USD",
        currentBalance: 1250.5,
        id: expect.any(String),
        mask: "1234",
        name: "Checking",
        officialName: "Plaid Gold Checking",
        plaidAccountId: "account-test-1",
        subtype: "checking",
        transactionCount: 1,
        type: "depository",
      },
    ]);
    expect(JSON.stringify(synced.body)).not.toContain("access-sandbox");

    failSync = true;
    expect((await sync()).status).toBe(502);
    expect((await detail()).body.connection).toMatchObject({
      errorCode: "ITEM_LOGIN_REQUIRED",
      errorMessage: "The login details of this item have changed.",
      status: "error",
    });
    failSync = false;
    expect((await sync()).status).toBe(200);
    expect((await detail()).body.connection).toMatchObject({
      errorCode: null,
      errorMessage: null,
      status: "active",
    });

    const disconnected = await app.request(
      financePath(`/connections/${id}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(disconnected.status).toBe(204);
    const afterDisconnect = await detail();
    expect(afterDisconnect.body.connection.status).toBe("disconnected");
    expect(afterDisconnect.body.connection.disconnectedAt).toBeString();
    expect(afterDisconnect.body.connection.transactions.count).toBe(1);

    for (const [organizationId, path] of [
      ["organization-2", `/connections/${id}`],
      ["org_user-1", "/connections/unknown"],
    ] as const) {
      const missing = await jsonRequest(
        testApp(organizationId, requestPlaid),
        fixture.bindings,
        path,
        "GET",
      );
      expect(missing.status).toBe(404);
    }
  });

  it("details an account with its connection and newest transactions", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const detail = await jsonRequest<AccountDetail>(
      fixture.app,
      fixture.bindings,
      "/accounts/account-report",
      "GET",
    );
    expect(detail.status).toBe(200);
    expect(detail.body.account).toMatchObject({
      id: "account-report",
      name: "Operating",
      plaidAccountId: "plaid-account-report",
      transactions: {
        count: 11,
        firstDate: "2026-07-20",
        lastDate: "2026-08-22",
      },
      type: "depository",
    });
    expect(detail.body.connection).toEqual({
      dailySync: false,
      id: "item-report",
      institutionId: null,
      institutionName: null,
      plaidItemId: "plaid-item-report",
      status: "active",
    });
    // The removed transaction and the oldest active one are left out.
    expect(detail.body.recentTransactions.map(({ id }) => id)).toEqual(
      [11, 10, 7, 6, 5, 4, 3, 2, 1, 0].map((index) => `report-txn-${index}`),
    );
    expect(detail.body.recentTransactions[0]).toEqual({
      amount: 25,
      currencyCode: "USD",
      id: "report-txn-11",
      merchantName: null,
      name: "Transaction 11",
      pending: false,
      transactionDate: "2026-08-22",
    });
    expect(JSON.stringify(detail.body)).not.toContain("access_token");

    for (const [organizationId, path] of [
      ["organization-2", "/accounts/account-report"],
      ["org_user-1", "/accounts/unknown"],
    ] as const) {
      const missing = await jsonRequest(
        testApp(organizationId, fixture.requestPlaid),
        fixture.bindings,
        path,
        "GET",
      );
      expect(missing.status).toBe(404);
    }
  });

  it("preserves an annotation when a pending transaction posts", async () => {
    const fixture = await createFixture({ pendingTransition: true });
    const exchange = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    const pending = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    const transactionId = pending.body.transactions[0]?.id;
    expect(pending.body.transactions[0]?.pending).toBe(true);
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/annotation`,
      "PATCH",
      {
        labels: ["watch"],
        note: "Waiting for this charge to settle.",
        reviewed: false,
      },
    );

    const sync = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${exchange.body.connectionId}/sync`,
      "POST",
    );
    expect(sync.body).toEqual({ added: 1, modified: 0, removed: 1 });
    const posted = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(posted.body.transactions).toHaveLength(1);
    expect(posted.body.transactions[0]).toMatchObject({
      annotation: {
        labels: ["watch"],
        note: "Waiting for this charge to settle.",
      },
      id: transactionId,
      pending: false,
    });
  });
});

interface AccountDetail {
  account: Record<string, unknown>;
  connection: Record<string, unknown>;
  recentTransactions: (Record<string, unknown> & { id: string })[];
}

interface ConnectionDetail {
  accounts: Record<string, unknown>[];
  connection: {
    disconnectedAt: string | null;
    lastSyncedAt: string | null;
    status: string;
    transactions: { count: number };
  };
}

/** Links First Test Bank and imports its one transaction. */
async function importedConnection(
  fixture: Awaited<ReturnType<typeof createFixture>>,
) {
  const exchange = await jsonRequest<{ connectionId: string }>(
    fixture.app,
    fixture.bindings,
    "/exchange",
    "POST",
    {
      institutionId: "ins_test",
      institutionName: "First Test Bank",
      publicToken: "public-sandbox-test",
    },
  );
  await jsonRequest(
    fixture.app,
    fixture.bindings,
    `/connections/${exchange.body.connectionId}/sync`,
    "POST",
  );
  const listing = await jsonRequest<FinanceListing>(
    fixture.app,
    fixture.bindings,
    "/",
    "GET",
  );
  return {
    accountId: listing.body.accounts[0]?.id,
    exchange,
    transactionId: listing.body.transactions[0]?.id,
  };
}
