import type { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { findActivity } from "./activity";
import { createFinanceRouter } from "./finance";
import { jobRunDetail } from "./jobHistory";
import { scheduleJobs } from "./jobScheduler";
import { consumeJobs as consumeFinanceSync } from "./jobWorker";
import {
  PlaidApiError,
  type PlaidRequest,
  type PlaidRequestBody,
  type TransactionsSyncResponse,
} from "./plaid";
import { testBindings } from "./testing/bindings";
import { queryHooks, toD1 } from "./testing/d1";
import { applyMigrations, createTestDatabase } from "./testing/database";
import { requester } from "./testing/http";
import { seedAccount, seedOrganization } from "./testing/seed";
import { testApp as sessionApp } from "./testing/session";
import type { Bindings } from "./types";

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

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

  it("retains and reconciles imported history after a disconnect", async () => {
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

describe("expense categories", () => {
  it("manages organization categories with case-insensitive unique names", async () => {
    const fixture = await createFixture();
    const created = await jsonRequest<{ category: Category }>(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "  Meals   and  drinks " },
    );
    expect(created.status).toBe(201);
    expect(created.body.category).toMatchObject({
      name: "Meals and drinks",
      slug: "meals-and-drinks",
      transactionCount: 0,
    });
    const categoryId = created.body.category.id;

    const duplicate = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "meals AND drinks" },
    );
    expect(duplicate.status).toBe(409);
    for (const name of ["", "   ", "x".repeat(61), 42]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        "/categories",
        "POST",
        { name },
      );
      expect(invalid).toMatchObject({
        body: { error: "Category names need 1 to 60 characters." },
        status: 400,
      });
    }

    const renamed = await jsonRequest<{ category: Category }>(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "Client meals" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.category).toMatchObject({
      id: categoryId,
      name: "Client meals",
      slug: "client-meals",
    });
    const sameNameOtherCase = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "client MEALS" },
    );
    expect(sameNameOtherCase.status).toBe(200);

    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    expect(defaults.status).toBe(200);
    expect(defaults.body.categories).toHaveLength(17);
    const again = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    expect(again.body.categories).toHaveLength(17);
    const names = again.body.categories.map(({ name }) => name);
    expect(names).toContain("Charitable contributions");
    expect(names).toContain("Personal");
    expect(names).toContain("Travel");
    const clash = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "travel" },
    );
    expect(clash.status).toBe(409);

    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<{ categories: Category[] }>(
      otherOrganization,
      fixture.bindings,
      "/categories",
      "GET",
    );
    expect(hidden.body.categories).toEqual([]);
    const cannotRename = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "Taken over" },
    );
    expect(cannotRename.status).toBe(404);
    const cannotDelete = await otherOrganization.request(
      financePath(`/categories/${categoryId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(cannotDelete.status).toBe(404);
  });

  it("slugs category names uniquely within each organization", async () => {
    const fixture = await createFixture();
    const create = async (name: string, app = fixture.app) => {
      const created = await jsonRequest<{ category: Category }>(
        app,
        fixture.bindings,
        "/categories",
        "POST",
        { name },
      );
      expect(created.status).toBe(201);
      return created.body.category;
    };
    const cafe = await create("Café & Bar");
    expect(cafe.slug).toBe("cafe-bar");
    const repeat = await create("--Cafe/Bar--");
    expect(repeat.slug).toBe("cafe-bar-2");
    expect((await create("Uncategorized")).slug).toBe("uncategorized-2");
    expect((await create("🍔")).slug).toBe("category");
    expect((await create("Travel!")).slug).toBe("travel");
    const elsewhere = await create(
      "Café & Bar",
      testApp("organization-2", fixture.requestPlaid),
    );
    expect(elsewhere.slug).toBe("cafe-bar");

    const rename = async (id: string, name: string) => {
      const renamed = await jsonRequest<{ category: Category }>(
        fixture.app,
        fixture.bindings,
        `/categories/${id}`,
        "PATCH",
        { name },
      );
      expect(renamed.status).toBe(200);
      return renamed.body.category.slug;
    };
    expect(await rename(repeat.id, "Cafe Bar!")).toBe("cafe-bar-2");
    expect(await rename(cafe.id, "Coffee")).toBe("coffee");
    expect(await rename(repeat.id, "Cafe & bar")).toBe("cafe-bar");

    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    const slugs = defaults.body.categories.map(({ name, slug }) => [
      name,
      slug,
    ]);
    expect(slugs).toContainEqual(["Travel", "travel-2"]);
    expect(slugs).toContainEqual([
      "Software and subscriptions",
      "software-and-subscriptions",
    ]);
    expect(() =>
      fixture.database.run(
        `INSERT INTO finance_expense_categories
           (id, organization_id, name, slug, created_at, updated_at)
         VALUES ('copy', 'org_user-1', 'Copy', 'coffee', '', '')`,
      ),
    ).toThrow(/UNIQUE/);
  });

  it("chooses another slug when a concurrent write takes it first", async () => {
    const fixture = await createFixture();
    const tea = await createCategory(fixture, "Tea");
    const raced = await jsonRequest<{ category: Category }>(
      fixture.app,
      raceForSlug(fixture, "cafe-bar"),
      "/categories",
      "POST",
      { name: "Cafe/Bar" },
    );
    expect(raced.status).toBe(201);
    expect(raced.body.category.slug).toBe("cafe-bar-2");
    const renamed = await jsonRequest<{ category: Category }>(
      fixture.app,
      raceForSlug(fixture, "snacks"),
      `/categories/${tea}`,
      "PATCH",
      { name: "Snacks" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.category.slug).toBe("snacks-2");
    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      raceForSlug(fixture, "travel"),
      "/categories/defaults",
      "POST",
    );
    expect(
      defaults.body.categories.find(({ name }) => name === "Travel")?.slug,
    ).toBe("travel-2");
    expect(defaults.body.categories).toHaveLength(21);
  });

  it("assigns at most one category per transaction and unassigns on delete", async () => {
    const fixture = await createFixture();
    const [transactionId] = seedTransactions(fixture.database);
    if (!transactionId) throw new Error("Missing seeded transaction.");
    const meals = await createCategory(fixture, "Meals");
    const travel = await createCategory(fixture, "Travel");

    for (const categoryId of [meals, travel]) {
      const assigned = await jsonRequest<{ expenseCategoryId: string }>(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        { categoryId },
      );
      expect(assigned.status).toBe(200);
      expect(assigned.body.expenseCategoryId).toBe(categoryId);
    }
    const listing = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    const transaction = listing.body.transactions.find(
      ({ id }) => id === transactionId,
    );
    expect(transaction?.expenseCategoryId).toBe(travel);
    expect(listing.body.categories).toMatchObject([
      { name: "Meals", transactionCount: 0 },
      { name: "Travel", transactionCount: 1 },
    ]);
    const annotations = fixture.database
      .query(
        "SELECT COUNT(*) AS count FROM finance_transaction_annotations WHERE transaction_id = ?",
      )
      .get(transactionId) as { count: number };
    expect(annotations.count).toBe(1);

    for (const body of [{}, { categoryId: 7 }, { categoryId: "" }, null]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        body,
      );
      expect(invalid).toMatchObject({
        body: { error: "A category or null is required." },
        status: 400,
      });
    }
    const unknownCategory = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: "missing" },
    );
    expect(unknownCategory.status).toBe(404);
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const foreignTransaction = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: null },
    );
    expect(foreignTransaction.status).toBe(404);

    const deleted = await fixture.app.request(
      financePath(`/categories/${travel}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleted.status).toBe(204);
    const afterDelete = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(
      afterDelete.body.transactions.find(({ id }) => id === transactionId)
        ?.expenseCategoryId,
    ).toBeNull();
    expect(afterDelete.body.categories.map(({ name }) => name)).toEqual([
      "Meals",
    ]);

    const cleared = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: null },
    );
    expect(cleared.status).toBe(200);
  });

  it("reports expense totals by category with transfers and income excluded", async () => {
    const fixture = await createFixture();
    const ids = seedTransactions(fixture.database);
    const meals = await createCategory(fixture, "Meals");
    const software = await createCategory(fixture, "Software");
    await createCategory(fixture, "Travel");
    const assignments: [number, string][] = [
      [0, meals],
      [1, meals],
      [2, meals],
      [9, meals],
      [11, software],
    ];
    for (const [index, categoryId] of assignments) {
      const assigned = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${ids[index]}/category`,
        "PUT",
        { categoryId },
      );
      expect(assigned.status).toBe(200);
    }

    const august = await jsonRequest<ExpenseReport>(
      fixture.app,
      fixture.bindings,
      "/reports/expenses?from=2026-08-01&to=2026-08-31",
      "GET",
    );
    expect(august.status).toBe(200);
    expect(august.body.from).toBe("2026-08-01");
    expect(august.body.to).toBe("2026-08-31");
    expect(august.body.currencies.map(({ currency }) => currency)).toEqual([
      "EUR",
      "USD",
    ]);
    const usd = august.body.currencies.find(
      ({ currency }) => currency === "USD",
    );
    expect(usd).toEqual({
      categories: [
        { id: null, name: "Uncategorized", total: 300, transactionCount: 1 },
        { id: meals, name: "Meals", total: 130.25, transactionCount: 3 },
        { id: software, name: "Software", total: 25, transactionCount: 1 },
        {
          id: expect.any(String),
          name: "Travel",
          total: 0,
          transactionCount: 0,
        },
      ],
      currency: "USD",
      excludedTransfers: { total: 575, transactionCount: 2 },
      total: 455.25,
      transactionCount: 5,
    });
    const eur = august.body.currencies.find(
      ({ currency }) => currency === "EUR",
    );
    expect(eur?.total).toBe(45);
    expect(eur?.categories[0]).toEqual({
      id: null,
      name: "Uncategorized",
      total: 45,
      transactionCount: 1,
    });

    const allTime = await jsonRequest<ExpenseReport>(
      fixture.app,
      fixture.bindings,
      "/reports/expenses",
      "GET",
    );
    const allTimeUsd = allTime.body.currencies.find(
      ({ currency }) => currency === "USD",
    );
    expect(allTime.body.from).toBeNull();
    expect(allTimeUsd?.total).toBe(535.25);
    expect(
      allTimeUsd?.categories.find(({ name }) => name === "Meals"),
    ).toMatchObject({ total: 210.25, transactionCount: 4 });

    for (const query of [
      "?from=2026-13-01",
      "?to=2026-02-30",
      "?from=2026-08-31&to=2026-08-01",
      "?from=yesterday",
    ]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/reports/expenses${query}`,
        "GET",
      );
      expect(invalid.status).toBe(400);
    }
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<ExpenseReport>(
      otherOrganization,
      fixture.bindings,
      "/reports/expenses",
      "GET",
    );
    expect(hidden.body.currencies).toEqual([]);
  });

  it("migrates free-text category overrides into categories", async () => {
    // The legacy annotations name transactions this test does not seed.
    const database = createTestDatabase({ before: "0034", foreignKeys: false });
    const overrides: [string, string, string | null][] = [
      ["txn-a", "org-a", "Client meal"],
      ["txn-b", "org-a", " client MEAL "],
      ["txn-c", "org-a", "Travel"],
      ["txn-d", "org-b", "Travel"],
      ["txn-e", "org-b", "   "],
      ["txn-f", "org-b", null],
    ];
    for (const [transactionId, organizationId, override] of overrides) {
      database
        .query(
          `INSERT INTO finance_transaction_annotations
             (transaction_id, organization_id, category_override, created_by,
              updated_by, created_at, updated_at)
           VALUES (?, ?, ?, 'user-1', 'user-1', ?, ?)`,
        )
        .run(
          transactionId,
          organizationId,
          override,
          "2026-08-19T12:00:00.000Z",
          "2026-08-19T12:00:00.000Z",
        );
    }
    applyMigrations(database, { from: "0034" });

    const categories = database
      .query(
        `SELECT organization_id, name FROM finance_expense_categories
         ORDER BY organization_id, name`,
      )
      .all();
    expect(categories).toEqual([
      { name: "Client meal", organization_id: "org-a" },
      { name: "Travel", organization_id: "org-a" },
      { name: "Travel", organization_id: "org-b" },
    ]);
    const assigned = database
      .query(
        `SELECT annotation.transaction_id, category.name, category.organization_id
         FROM finance_transaction_annotations AS annotation
         LEFT JOIN finance_expense_categories AS category
           ON category.id = annotation.expense_category_id
         ORDER BY annotation.transaction_id`,
      )
      .all();
    expect(assigned).toEqual([
      {
        name: "Client meal",
        organization_id: "org-a",
        transaction_id: "txn-a",
      },
      {
        name: "Client meal",
        organization_id: "org-a",
        transaction_id: "txn-b",
      },
      { name: "Travel", organization_id: "org-a", transaction_id: "txn-c" },
      { name: "Travel", organization_id: "org-b", transaction_id: "txn-d" },
      { name: null, organization_id: null, transaction_id: "txn-e" },
      { name: null, organization_id: null, transaction_id: "txn-f" },
    ]);
  });

  it("backfills category slugs that are unique in each organization", async () => {
    const database = createTestDatabase({ before: "0065" });
    for (const id of ["org-a", "org-b"]) seedOrganization(database, { id });
    const categories: [string, string, string][] = [
      ["a1234567-first", "org-a", "Meals & drinks"],
      ["b1234567-second", "org-a", "Meals/drinks"],
      ["c1234567-third", "org-a", "Meals drinks 2"],
      ["d1234567-fourth", "org-a", "Uncategorized"],
      ["e1234567-fifth", "org-a", "Taxes (2026)"],
      ["f1234567-sixth", "org-a", "🍔"],
      ["g1234567-seventh", "org-a", "Café"],
      ["h1234567-eighth", "org-b", "Meals/drinks"],
      ["j1234567-tenth", "org-a", "b1234567-second"],
    ];
    for (const [index, [id, organizationId, name]] of categories.entries()) {
      database
        .query(
          `INSERT INTO finance_expense_categories
             (id, organization_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, organizationId, name, `2026-08-0${index + 1}`, "");
    }
    applyMigrations(database, { from: "0065" });

    expect(
      database
        .query("SELECT id, slug FROM finance_expense_categories ORDER BY id")
        .all(),
    ).toEqual([
      { id: "a1234567-first", slug: "meals-drinks" },
      { id: "b1234567-second", slug: "meals-drinks-2--b1234567-second" },
      { id: "c1234567-third", slug: "meals-drinks-2" },
      { id: "d1234567-fourth", slug: "uncategorized-2" },
      { id: "e1234567-fifth", slug: "taxes-2026" },
      { id: "f1234567-sixth", slug: "category" },
      // Unlike the API, the backfill cannot fold accents.
      { id: "g1234567-seventh", slug: "caf" },
      { id: "h1234567-eighth", slug: "meals-drinks" },
      { id: "j1234567-tenth", slug: "b1234567-second" },
    ]);

    // Categories the previous Worker creates during deployment get a slug.
    database.run(
      `INSERT INTO finance_expense_categories
         (id, organization_id, name, created_at, updated_at)
       VALUES ('i1234567-ninth', 'org-a', 'Postage', '', '')`,
    );
    expect(
      database
        .query(
          "SELECT slug FROM finance_expense_categories WHERE id = 'i1234567-ninth'",
        )
        .get(),
    ).toEqual({ slug: "i1234567-ninth" });
  });
});

interface Category {
  id: string;
  name: string;
  slug: string;
  transactionCount: number;
}

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

interface ExpenseReport {
  currencies: {
    categories: {
      id: string | null;
      name: string;
      total: number;
      transactionCount: number;
    }[];
    currency: string;
    excludedTransfers: { total: number; transactionCount: number };
    total: number;
    transactionCount: number;
  }[];
  from: string | null;
  to: string | null;
}

async function createCategory(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  name: string,
) {
  const created = await jsonRequest<{ category: Category }>(
    fixture.app,
    fixture.bindings,
    "/categories",
    "POST",
    { name },
  );
  expect(created.status).toBe(201);
  return created.body.category.id;
}

/** Bindings where another category takes `slug` just before the next write. */
function raceForSlug(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  slug: string,
): Bindings {
  // The defaults batch races ahead of its first statement, as D1 serializes it.
  fixture.hooks.before(
    /^\s*(INSERT|UPDATE)\b.*finance_expense_categories\b/,
    () => {
      fixture.database
        .query(
          `INSERT INTO finance_expense_categories
             (id, organization_id, name, slug, created_at, updated_at)
           VALUES (?, 'org_user-1', ?, ?, '', '')`,
        )
        .run(`rival-${slug}`, `Rival ${slug}`, slug);
    },
  );
  return fixture.bindings;
}

/**
 * Twelve transactions for org_user-1 that exercise every reporting rule.
 * Positive amounts are money leaving the account, as Plaid reports them.
 */
function seedTransactions(database: Database) {
  const now = "2026-08-31T12:00:00.000Z";
  database
    .query(
      `INSERT INTO plaid_items
         (id, organization_id, plaid_item_id, access_token_ciphertext,
          access_token_iv, status, created_by, created_at, updated_at)
       VALUES ('item-report', 'org_user-1', 'plaid-item-report', '', '',
               'active', 'user-1', ?, ?)`,
    )
    .run(now, now);
  database
    .query(
      `INSERT INTO plaid_accounts
         (id, plaid_account_id, organization_id, plaid_item_record_id, name,
          type, updated_at)
       VALUES ('account-report', 'plaid-account-report', 'org_user-1',
               'item-report', 'Operating', 'depository', ?)`,
    )
    .run(now);
  const rows: [number, string, string | null, number, string, string][] = [
    [100, "2026-08-05", "FOOD_AND_DRINK", 0, "active", "USD"],
    [50.25, "2026-08-10", "FOOD_AND_DRINK", 0, "active", "USD"],
    [-20, "2026-08-12", "FOOD_AND_DRINK", 0, "active", "USD"],
    [300, "2026-08-14", "GENERAL_SERVICES", 0, "active", "USD"],
    [500, "2026-08-15", "TRANSFER_OUT", 0, "active", "USD"],
    [75, "2026-08-16", "LOAN_PAYMENTS", 0, "active", "USD"],
    [-1000, "2026-08-17", "INCOME", 0, "active", "USD"],
    [40, "2026-08-18", "FOOD_AND_DRINK", 1, "active", "USD"],
    [60, "2026-08-19", "GENERAL_MERCHANDISE", 0, "removed", "USD"],
    [80, "2026-07-20", "FOOD_AND_DRINK", 0, "active", "USD"],
    [45, "2026-08-21", "TRAVEL", 0, "active", "EUR"],
    [25, "2026-08-22", "TRANSFER_OUT", 0, "active", "USD"],
  ];
  return rows.map(
    ([amount, date, category, pending, status, currency], index) => {
      const id = `report-txn-${index}`;
      database
        .query(
          `INSERT INTO plaid_transactions
           (id, plaid_transaction_id, organization_id, plaid_item_record_id,
            account_record_id, name, amount, currency_code, transaction_date,
            category_primary, pending, source_status, updated_at)
         VALUES (?, ?, 'org_user-1', 'item-report', 'account-report', ?, ?, ?,
                 ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          `plaid-${id}`,
          `Transaction ${index}`,
          amount,
          currency,
          date,
          category,
          pending,
          status,
          now,
        );
      return id;
    },
  );
}

interface FinanceListing {
  nextCursor: string | null;
  accounts: { id: string }[];
  categories: Category[];
  configured: boolean;
  connections: { accountCount: number; status: string }[];
  transactions: {
    annotation: {
      labels: string[];
      note: string;
      reviewed: boolean;
    };
    expenseCategoryId: string | null;
    id: string;
    pending: boolean;
  }[];
}

async function createFixture(options?: { pendingTransition?: boolean }) {
  const database = createTestDatabase();
  seedAccount(database, {
    createdAt: "2026-08-19T12:00:00.000Z",
    email: "person@example.com",
    emailVerified: false,
    id: "user-1",
    name: "Example Person",
  });
  // Another tenant whose writes must stay out of org_user-1's views.
  seedOrganization(database, { id: "organization-2" });
  const requestPlaid = mockPlaid(options);
  const hooks = queryHooks();
  const bindings = testBindings({
    DB: toD1(database, hooks),
    PLAID_CLIENT_ID: "client-test",
    PLAID_ENV: "sandbox",
    PLAID_REDIRECT_URI: "https://app.test/finance",
    PLAID_SECRET: "secret-test",
    PLAID_TOKEN_ENCRYPTION_KEY: encryptionKey,
  });
  return {
    app: testApp("org_user-1", requestPlaid),
    bindings,
    database,
    hooks,
    requestPlaid,
  };
}

function mockPlaid(options?: { pendingTransition?: boolean }): PlaidRequest {
  let exchangeCount = 0;
  let syncCount = 0;
  return async <T>(_env: Bindings, path: string, body: PlaidRequestBody) => {
    if (path === "/link/token/create") {
      expect(body.transactions).toEqual({ days_requested: 730 });
      return {
        expiration: "2026-08-19T12:30:00Z",
        link_token: "link-sandbox-test",
      } as T;
    }
    if (path === "/item/public_token/exchange") {
      expect(body.public_token).toBe("public-sandbox-test");
      exchangeCount += 1;
      return {
        access_token: `access-sandbox-test-${exchangeCount}`,
        item_id: `item-sandbox-test-${exchangeCount}`,
      } as T;
    }
    if (path === "/transactions/sync") {
      expect(body.access_token).toStartWith("access-sandbox-test-");
      syncCount += 1;
      if (options?.pendingTransition) {
        return (syncCount === 1 ? pendingPage() : postedPage()) as T;
      }
      const connectionNumber = String(body.access_token).split("-").at(-1);
      return transactionPage(connectionNumber) as T;
    }
    if (path === "/item/remove") {
      expect(body.access_token).toStartWith("access-sandbox-test-");
      return { request_id: "remove-test" } as T;
    }
    throw new Error(`Unexpected Plaid path: ${path}`);
  };
}

function transactionPage(connectionNumber = "1"): TransactionsSyncResponse {
  return {
    accounts: [
      {
        account_id: `account-test-${connectionNumber}`,
        balances: {
          available: 1200,
          current: 1250.5,
          iso_currency_code: "USD",
          unofficial_currency_code: null,
        },
        mask: "1234",
        name: "Checking",
        official_name: "Plaid Gold Checking",
        subtype: "checking",
        type: "depository",
      },
    ],
    added: [
      {
        account_id: `account-test-${connectionNumber}`,
        amount: 42.75,
        authorized_date: "2026-08-18",
        date: "2026-08-19",
        iso_currency_code: "USD",
        merchant_name: "Test Cafe",
        name: "Test Cafe Purchase",
        payment_channel: "in store",
        pending: false,
        pending_transaction_id: null,
        personal_finance_category: {
          detailed: "FOOD_AND_DRINK_RESTAURANT",
          primary: "FOOD_AND_DRINK",
        },
        transaction_id: `transaction-test-${connectionNumber}`,
        unofficial_currency_code: null,
      },
    ],
    has_more: false,
    modified: [],
    next_cursor: "cursor-test",
    removed: [],
  };
}

function pendingPage(): TransactionsSyncResponse {
  const page = transactionPage();
  const transaction = page.added[0];
  if (!transaction) throw new Error("Missing transaction fixture.");
  transaction.pending = true;
  transaction.transaction_id = "transaction-pending";
  page.next_cursor = "cursor-pending";
  return page;
}

function postedPage(): TransactionsSyncResponse {
  const page = transactionPage();
  const transaction = page.added[0];
  if (!transaction) throw new Error("Missing transaction fixture.");
  transaction.pending_transaction_id = "transaction-pending";
  transaction.transaction_id = "transaction-posted";
  page.next_cursor = "cursor-posted";
  page.removed = [{ transaction_id: "transaction-pending" }];
  return page;
}

function testApp(organizationId: string, requestPlaid: PlaidRequest) {
  const app = sessionApp(
    {},
    {
      email: "person@example.com",
      name: "Example Person",
      organizationId,
      userId: "user-1",
    },
  );
  app.use("*", async (context, next) => {
    context.env = {
      ...context.env,
      FINANCE_SYNC_QUEUE:
        context.env.FINANCE_SYNC_QUEUE ??
        ({
          send: async (body: { jobId: string }) =>
            consumeFinanceSync(
              {
                messages: [{ body, ack() {}, retry() {} }],
              } as unknown as MessageBatch<{ jobId: string }>,
              context.env,
              requestPlaid,
            ),
        } as unknown as Queue<{ jobId: string }>),
    };
    await next();
  });
  app.route("/api/finance", createFinanceRouter(requestPlaid));
  return app;
}

function jsonRequest<T = unknown>(
  app: ReturnType<typeof testApp>,
  bindings: Bindings,
  path: string,
  method: string,
  body?: unknown,
) {
  return requester(app, bindings)<T>(method, financePath(path), body);
}

function financePath(path: string) {
  return path === "/" ? "/api/finance" : `/api/finance${path}`;
}

async function queuedFixture() {
  const fixture = await createFixture();
  const messages: { jobId: string }[] = [];
  fixture.bindings.FINANCE_SYNC_QUEUE = {
    send: async (body: { jobId: string }) => {
      messages.push(body);
    },
  } as unknown as Queue<{ jobId: string }>;
  const exchange = await jsonRequest<{ connectionId: string }>(
    fixture.app,
    fixture.bindings,
    "/exchange",
    "POST",
    { publicToken: "public-sandbox-test" },
  );
  const id = exchange.body.connectionId;
  const request = <T = Record<string, unknown>>(
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    jsonRequest<T>(
      fixture.app,
      fixture.bindings,
      `/connections/${id}${path}`,
      method,
      body,
    );
  const deliver = (jobId: string, plaid = fixture.requestPlaid) =>
    consumeFinanceSync(
      {
        messages: [
          {
            body: { jobId },
            ack() {},
            retry() {
              throw new Error("Unexpected delivery failure");
            },
          },
        ],
      } as unknown as MessageBatch<{ jobId: string }>,
      fixture.bindings,
      plaid,
    );
  return { ...fixture, id, request, messages, deliver };
}

describe("durable finance sync", () => {
  it("accepts a manual job before any Plaid work, deduplicates clicks, and finishes without another browser request", async () => {
    const fixture = await queuedFixture();
    const first = await fixture.request<{ id: string; status: string }>(
      "/sync-jobs",
      "POST",
    );
    expect(first.status).toBe(202);
    expect(first.body.status).toBe("queued");
    expect((await fixture.request("/sync-status")).body).toMatchObject({
      connection: { syncJob: { id: first.body.id, status: "queued" } },
    });
    const foreign = await jsonRequest(
      testApp("org-other", fixture.requestPlaid),
      fixture.bindings,
      `/connections/${fixture.id}/sync-status`,
      "GET",
    );
    expect(foreign.status).toBe(404);
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_accounts")
        .get(),
    ).toEqual({ count: 0 });
    const second = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    expect(second.body.id).toBe(first.body.id);
    await fixture.deliver(first.body.id);
    await fixture.deliver(first.body.id);
    const detail = await fixture.request<{
      connection: {
        syncJob: { status: string; added: number };
        lastSyncedAt: string;
      };
    }>("");
    expect(detail.body.connection.syncJob).toMatchObject({
      status: "succeeded",
      added: 1,
    });
    expect(detail.body.connection.lastSyncedAt).toBeString();
    const saved = await jobRunDetail(fixture.bindings.DB, first.body.id);
    expect(saved?.run).toMatchObject({
      jobId: "syncFinanceConnection",
      status: "succeeded",
      attempts: 1,
      output: { added: 1, modified: 0, removed: 0, pages: 1, restarts: 0 },
    });
    expect(saved?.logs.map((log) => log.message)).toEqual([
      "Job queued.",
      "Processing attempt started.",
      "Job completed.",
    ]);
    expect(JSON.stringify(saved)).not.toContain("cursor-test");
    expect(JSON.stringify(saved)).not.toContain("access-sandbox");
    const status = await fixture.request("/sync-status");
    expect(status.body).toMatchObject({
      connection: {
        syncJob: { status: "succeeded", added: 1 },
        lastSyncedAt: detail.body.connection.lastSyncedAt,
      },
    });
    expect(status.body).not.toHaveProperty("accounts");
    expect(status.body).not.toHaveProperty("connection.transactions");
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database.query("SELECT requested_by FROM job_runs").get(),
    ).toMatchObject({ requested_by: "user-1" });
  });

  it("audits setting changes atomically, skips no-ops, and enforces organization boundaries and valid input", async () => {
    const fixture = await queuedFixture();
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: "true" }))
        .status,
    ).toBe(400);
    expect(
      (
        await fixture.request("/sync-settings", "PATCH", {
          dailySync: true,
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: true }))
        .body,
    ).toEqual({ dailySync: true });
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    const rows = fixture.database
      .query(
        "SELECT json_extract(details, '$.after') AS daily_sync, actor_user_id FROM activity_events WHERE action = 'finance.daily_sync_changed'",
      )
      .all();
    expect(rows).toEqual([{ daily_sync: 1, actor_user_id: "user-1" }]);
    const other = testApp("other-org", fixture.requestPlaid);
    for (const [path, method, body] of [
      ["sync-settings", "PATCH", { dailySync: false }],
      ["sync-jobs", "POST", undefined],
    ] as const) {
      expect(
        (
          await jsonRequest(
            other,
            fixture.bindings,
            `/connections/${fixture.id}/${path}`,
            method,
            body,
          )
        ).status,
      ).toBe(404);
    }
    fixture.database.exec(`CREATE TRIGGER fail_settings_history BEFORE INSERT ON activity_events WHEN NEW.action = 'finance.daily_sync_changed'
      BEGIN SELECT RAISE(ABORT, 'history failed'); END;`);
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: false }))
        .status,
    ).toBe(500);
    expect(
      fixture.database.query("SELECT daily_sync FROM plaid_items").get(),
    ).toEqual({ daily_sync: 1 });
  });

  it("recovers an unsent manual job from the durable outbox", async () => {
    const fixture = await queuedFixture();
    const producer = fixture.bindings.FINANCE_SYNC_QUEUE;
    if (!producer) throw new Error("Expected queue");
    fixture.bindings.FINANCE_SYNC_QUEUE = {
      send: async () => {
        throw new Error("Queue unavailable");
      },
    } as unknown as Queue<{ jobId: string }>;
    const accepted = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    expect(accepted.status).toBe(202);
    expect(fixture.messages).toHaveLength(0);
    fixture.bindings.FINANCE_SYNC_QUEUE = producer;
    await scheduleJobs(fixture.bindings);
    expect(fixture.messages).toEqual([{ jobId: accepted.body.id }]);
    await fixture.deliver(accepted.body.id);
    expect(fixture.database.query("SELECT status FROM job_runs").get()).toEqual(
      { status: "succeeded" },
    );
  });

  it("schedules only opted-in connections once per UTC day and stops future runs when disabled", async () => {
    const fixture = await queuedFixture();
    const today = Date.now();
    await scheduleJobs(fixture.bindings, today);
    expect(fixture.messages).toHaveLength(0);
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    await scheduleJobs(fixture.bindings, today);
    const job = fixture.messages[0];
    if (!job) throw new Error("Expected daily job");
    await fixture.deliver(job.jobId);
    await scheduleJobs(fixture.bindings, today);
    expect(
      fixture.database.query("SELECT count(*) AS count FROM job_runs").get(),
    ).toEqual({ count: 1 });
    await scheduleJobs(fixture.bindings, today + 86_400_000);
    expect(
      fixture.database.query("SELECT count(*) AS count FROM job_runs").get(),
    ).toEqual({ count: 2 });
    expect(
      fixture.database
        .query("SELECT source, requested_by FROM job_runs LIMIT 1")
        .get(),
    ).toEqual({ source: "daily", requested_by: null });
    // Let the accepted run finish; disabling changes future scheduling only.
    fixture.database.run(
      "UPDATE job_runs SET available_at = '2000-01-01' WHERE status = 'queued'",
    );
    const next = fixture.messages.find(({ jobId }) => jobId !== job.jobId);
    if (!next) throw new Error("Expected next day's job");
    await fixture.deliver(next.jobId);
    await fixture.request("/sync-settings", "PATCH", { dailySync: false });
    await scheduleJobs(fixture.bindings, today + 2 * 86_400_000);
    expect(
      fixture.database.query("SELECT count(*) AS count FROM job_runs").get(),
    ).toEqual({ count: 2 });
  });

  it("leases one consumer at a time and rejects disconnects while a job is active", async () => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    let finish: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const plaid: PlaidRequest = async <T>() => {
      calls++;
      await waiting;
      return transactionPage() as T;
    };
    const running = fixture.deliver(job.id, plaid);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.deliver(job.id, plaid);
    expect(calls).toBe(1);
    expect((await fixture.request("", "DELETE")).status).toBe(409);
    expect(
      (await fixture.request<{ id: string }>("/sync-jobs", "POST")).body.id,
    ).toBe(job.id);
    finish?.();
    await running;
    expect((await fixture.request("", "DELETE")).status).toBe(204);
    expect((await fixture.request("/sync-jobs", "POST")).status).toBe(404);
    expect(
      (await fixture.request("/sync-settings", "PATCH", { dailySync: true }))
        .status,
    ).toBe(404);
  });

  it("checkpoints pages, resumes a lost lease, and restarts pagination on Plaid mutations", async () => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    const cursors: unknown[] = [];
    let mutated = false;
    const plaid: PlaidRequest = async <T>(
      _env: Bindings,
      _path: string,
      body: PlaidRequestBody,
    ) => {
      cursors.push(body.cursor);
      if (body.cursor === "page-1" && !mutated) {
        mutated = true;
        throw new PlaidApiError(
          "Restart pagination",
          "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
          400,
        );
      }
      const page = transactionPage();
      page.has_more = !body.cursor;
      page.next_cursor = body.cursor ? "finished" : "page-1";
      if (body.cursor) page.added = [];
      return page as T;
    };
    await fixture.deliver(job.id, plaid);
    expect(
      fixture.database.query("SELECT cursor FROM plaid_items").get(),
    ).toEqual({ cursor: null });
    // Simulate an isolate disappearing after it acquired the next page.
    fixture.database.run(
      "UPDATE job_runs SET status = 'running', lease_until = '2000-01-01'",
    );
    await scheduleJobs(fixture.bindings);
    await fixture.deliver(job.id, plaid);
    await fixture.deliver(job.id, plaid);
    await fixture.deliver(job.id, plaid);
    expect(cursors).toEqual([undefined, "page-1", undefined, "page-1"]);
    const history = await jobRunDetail(fixture.bindings.DB, job.id);
    expect(history?.logs.map((log) => log.message)).toContain(
      "Bank page saved.",
    );
    expect(history?.logs.map((log) => log.message)).toContain(
      "Bank pagination restarted.",
    );
    expect(
      fixture.database
        .query("SELECT status, added, restarts FROM job_runs")
        .get(),
    ).toEqual({ status: "succeeded", added: 1, restarts: 1 });
    expect(
      fixture.database
        .query("SELECT count(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.database.query("SELECT cursor FROM plaid_items").get(),
    ).toEqual({ cursor: "finished" });
  });

  it("backs off transient failures, stops after five attempts, and allows a fresh manual retry", async () => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    let calls = 0;
    const failing: PlaidRequest = async () => {
      calls++;
      throw new PlaidApiError("Try later", "INTERNAL_SERVER_ERROR", 500);
    };
    await fixture.deliver(job.id, failing);
    await fixture.deliver(job.id, failing);
    expect(calls).toBe(1);
    for (let attempt = 1; attempt < 5; attempt++) {
      fixture.database.run("UPDATE job_runs SET available_at = '2000-01-01'");
      await fixture.deliver(job.id, failing);
    }
    expect(
      fixture.database.query("SELECT status, failures FROM job_runs").get(),
    ).toEqual({ status: "failed", failures: 5 });
    expect(
      fixture.database
        .query("SELECT status, error_code FROM plaid_items")
        .get(),
    ).toEqual({ status: "error", error_code: "INTERNAL_SERVER_ERROR" });
    const retry = await fixture.request<{ id: string }>("/sync-jobs", "POST");
    expect(retry.body.id).not.toBe(job.id);
    await fixture.deliver(retry.body.id);
    expect(
      fixture.database.query("SELECT status FROM plaid_items").get(),
    ).toEqual({ status: "active" });
  });

  it("cancels pending jobs for deleted organizations and never schedules them", async () => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    fixture.database.run(
      "UPDATE organization SET deletedAt = '2026-01-01' WHERE id = 'org_user-1'",
    );
    await fixture.deliver(job.id, async () => {
      throw new Error("Must not contact Plaid");
    });
    expect(fixture.database.query("SELECT status FROM job_runs").get()).toEqual(
      { status: "cancelled" },
    );
    fixture.messages.length = 0;
    await scheduleJobs(fixture.bindings);
    expect(fixture.messages).toHaveLength(0);
  });
});

it("keeps legacy sync running during backoff and returns a background status when its waiter expires", async () => {
  const fixture = await queuedFixture();
  const { body: job } = await fixture.request<{ id: string }>(
    "/sync-jobs",
    "POST",
  );
  await fixture.deliver(job.id, async () => {
    throw new PlaidApiError("Temporary outage", "INTERNAL_SERVER_ERROR", 500);
  });
  const originalTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => originalTimer(callback, 0)) as typeof setTimeout);
  try {
    const result = await fixture.request("/sync", "POST");
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: expect.stringContaining("continues in the background"),
    });
    expect(timer).toHaveBeenCalledTimes(100);
  } finally {
    timer.mockRestore();
  }
  fixture.database.run("UPDATE job_runs SET available_at = '2000-01-01'");
  await fixture.deliver(job.id);
  expect(fixture.database.query("SELECT status FROM job_runs").get()).toEqual({
    status: "succeeded",
  });
});

it.each(["active", "error"])(
  "restores %s status and releases the disconnect claim when Plaid fails",
  async (status) => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    fixture.database.query("UPDATE plaid_items SET status = ?").run(status);
    const app = testApp("org_user-1", async () => {
      throw new PlaidApiError("Unavailable", "INTERNAL_SERVER_ERROR", 500);
    });
    const result = await jsonRequest(
      app,
      fixture.bindings,
      `/connections/${fixture.id}`,
      "DELETE",
    );
    expect(result.status).toBe(502);
    expect(
      fixture.database
        .query(
          "SELECT status, daily_sync, disconnect_lease_until FROM plaid_items",
        )
        .get(),
    ).toEqual({ status, daily_sync: 1, disconnect_lease_until: null });
    expect(
      fixture.database
        .query(
          "SELECT id FROM activity_events WHERE action = 'finance.connection_disconnected'",
        )
        .all(),
    ).toEqual([]);
    expect((await fixture.request("/sync-jobs", "POST")).status).toBe(202);
  },
);

it("records connection changes in shared activity with Finance reader permissions and deletion retention", async () => {
  const fixture = await queuedFixture();
  await fixture.request("/sync-settings", "PATCH", { dailySync: true });
  await fixture.request("/sync-settings", "PATCH", { dailySync: true });
  const denied = await findActivity(
    fixture.bindings.DB,
    "org_user-1",
    undefined,
    undefined,
    false,
    "finance_connection",
  );
  expect(denied?.events).toEqual([]);
  const page = await findActivity(
    fixture.bindings.DB,
    "org_user-1",
    undefined,
    undefined,
    true,
    "finance_connection",
  );
  expect(page?.events).toHaveLength(1);
  expect(page?.events[0]).toMatchObject({
    action: "finance.daily_sync_changed",
    actor: { id: "user-1", email: "person@example.com" },
    details: { before: false, after: true },
  });
  const started = await fixture.request<{ id: string }>("/sync-jobs", "POST");
  await fixture.request("/sync-jobs", "POST");
  expect(
    fixture.database
      .query(
        "SELECT count(*) AS count FROM activity_events WHERE action = 'finance.sync_requested'",
      )
      .get(),
  ).toEqual({ count: 1 });
  await fixture.deliver(started.body.id);
  await fixture.request("", "DELETE");
  expect(
    fixture.database
      .query(
        "SELECT count(*) AS count FROM activity_events WHERE action = 'finance.connection_disconnected'",
      )
      .get(),
  ).toEqual({ count: 1 });
  await fixture.request("/data", "DELETE");
  expect(
    fixture.database
      .query(
        "SELECT id FROM activity_events WHERE root_type = 'finance_connection'",
      )
      .all(),
  ).toEqual([]);
});

it.each(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"])(
  "finishes an expired disconnect after Plaid already removed the Item (%s)",
  async (code) => {
    const fixture = await queuedFixture();
    await fixture.request("/sync-settings", "PATCH", { dailySync: true });
    fixture.database
      .query(`UPDATE plaid_items SET status = 'disconnecting',
      disconnect_lease_until = ?`)
      .run(new Date(Date.now() + 60_000).toISOString());
    let removals = 0;
    const app = testApp("org_user-1", async () => {
      removals++;
      throw new PlaidApiError("Item already removed", code, 400);
    });
    const disconnect = () =>
      jsonRequest(
        app,
        fixture.bindings,
        `/connections/${fixture.id}`,
        "DELETE",
      );
    expect((await disconnect()).status).toBe(409);
    expect(removals).toBe(0);
    fixture.database
      .query("UPDATE plaid_items SET disconnect_lease_until = ?")
      .run(new Date(Date.now() - 60_000).toISOString());
    expect((await disconnect()).status).toBe(204);
    expect(removals).toBe(1);
    expect(
      fixture.database
        .query(`SELECT status, daily_sync, access_token_ciphertext,
      disconnect_lease_until FROM plaid_items`)
        .get(),
    ).toEqual({
      status: "disconnected",
      daily_sync: 0,
      access_token_ciphertext: "",
      disconnect_lease_until: null,
    });
    expect(
      fixture.database
        .query(`SELECT count(*) AS count FROM activity_events
      WHERE action = 'finance.connection_disconnected'`)
        .get(),
    ).toEqual({ count: 1 });
  },
);

it.each(["queued", "backoff", "expired"])(
  "disconnects by cancelling %s work without requiring queue delivery",
  async (state) => {
    const fixture = await queuedFixture();
    const { body: job } = await fixture.request<{ id: string }>(
      "/sync-jobs",
      "POST",
    );
    if (state === "backoff")
      fixture.database
        .query("UPDATE job_runs SET available_at = ?")
        .run(new Date(Date.now() + 8 * 60_000).toISOString());
    if (state === "expired")
      fixture.database
        .query("UPDATE job_runs SET status = 'running', lease_until = ?")
        .run(new Date(Date.now() - 60_000).toISOString());
    expect((await fixture.request("", "DELETE")).status).toBe(204);
    expect(
      fixture.database
        .query("SELECT status, error_code, lease_until FROM job_runs")
        .get(),
    ).toEqual({
      status: "cancelled",
      error_code: "SYNC_CANCELLED",
      lease_until: null,
    });
    let calls = 0;
    await fixture.deliver(job.id, async <T>() => {
      calls++;
      return transactionPage() as T;
    });
    expect(calls).toBe(0);
    expect((await fixture.request("/data", "DELETE")).status).toBe(204);
  },
);

it("finishes disconnecting after a lost Plaid removal response", async () => {
  const fixture = await queuedFixture();
  let calls = 0;
  const app = testApp("org_user-1", async () => {
    if (++calls === 1) throw new Error("Response lost after removal");
    throw new PlaidApiError("Already removed", "ITEM_NOT_FOUND", 400);
  });
  const disconnect = () =>
    jsonRequest(app, fixture.bindings, `/connections/${fixture.id}`, "DELETE");
  expect((await disconnect()).status).toBe(500);
  expect(
    fixture.database.query("SELECT status FROM plaid_items").get(),
  ).toEqual({ status: "active" });
  expect((await disconnect()).status).toBe(204);
  expect(
    fixture.database.query("SELECT status FROM plaid_items").get(),
  ).toEqual({ status: "disconnected" });
});
