import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { createFinanceRouter } from "../finance/finance";
import type {
  PlaidRequest,
  PlaidRequestBody,
  TransactionsSyncResponse,
} from "../finance/plaid";
import { consumeJobs as consumeFinanceSync } from "../jobWorker";
import type { Bindings } from "../types";
import { testBindings } from "./bindings";
import { queryHooks, toD1 } from "./d1";
import { createTestDatabase } from "./database";
import { requester } from "./http";
import { seedAccount, seedOrganization } from "./seed";
import { testApp as sessionApp } from "./session";

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

export interface Category {
  id: string;
  name: string;
  slug: string;
  transactionCount: number;
}

export async function createCategory(
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

/**
 * Twelve transactions for org_user-1 that exercise every reporting rule.
 * Positive amounts are money leaving the account, as Plaid reports them.
 */
export function seedTransactions(database: Database) {
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

export interface FinanceListing {
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

export async function createFixture(options?: { pendingTransition?: boolean }) {
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

export function mockPlaid(options?: {
  pendingTransition?: boolean;
}): PlaidRequest {
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

export function transactionPage(
  connectionNumber = "1",
): TransactionsSyncResponse {
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

export function testApp(organizationId: string, requestPlaid: PlaidRequest) {
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

export function jsonRequest<T = unknown>(
  app: ReturnType<typeof testApp>,
  bindings: Bindings,
  path: string,
  method: string,
  body?: unknown,
) {
  return requester(app, bindings)<T>(method, financePath(path), body);
}

export function financePath(path: string) {
  return path === "/" ? "/api/finance" : `/api/finance${path}`;
}
