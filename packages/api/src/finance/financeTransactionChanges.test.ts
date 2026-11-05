import { describe, expect, it } from "bun:test";
import type {
  FinanceTransaction,
  FinanceTransactionChanges,
} from "@balebase/validators/finance";
import { purgeDeletedOrganizations } from "../organizations/organizationPurge";
import {
  createCategory,
  createFixture,
  jsonRequest,
  seedTransactions,
  testApp,
} from "../testing/financeFixture";
import {
  fixture as maintenanceFixture,
  now,
} from "../testing/maintenanceFixture";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** What a device keeps: every transaction it was sent, as last sent. */
interface Device {
  cursor: string | null;
  pages: number;
  transactions: Map<string, FinanceTransaction>;
}

function newDevice(): Device {
  return { cursor: null, pages: 0, transactions: new Map() };
}

async function changes(
  fixture: Fixture,
  cursor: string | null,
  app = fixture.app,
) {
  return jsonRequest<FinanceTransactionChanges>(
    app,
    fixture.bindings,
    `/transactions/changes${cursor ? `?cursor=${cursor}` : ""}`,
    "GET",
  );
}

/** Applies one page as the app does. */
function apply(device: Device, page: FinanceTransactionChanges) {
  for (const transaction of page.transactions)
    device.transactions.set(transaction.id, transaction);
  for (const id of page.removedIds) device.transactions.delete(id);
  device.cursor = page.cursor;
  device.pages++;
}

/** Pulls until the device has caught up. */
async function pull(fixture: Fixture, device: Device) {
  for (;;) {
    const { body, status } = await changes(fixture, device.cursor);
    expect(status).toBe(200);
    apply(device, body);
    if (!body.more) return device;
  }
}

/** The server's own view, for comparison with a device's copy. */
async function listing(fixture: Fixture) {
  const all: FinanceTransaction[] = [];
  let cursor: string | null = null;
  do {
    const response: {
      body: { nextCursor: string | null; transactions: FinanceTransaction[] };
    } = await jsonRequest(
      fixture.app,
      fixture.bindings,
      cursor ? `?cursor=${cursor}` : "/",
      "GET",
    );
    const { body } = response;
    all.push(...body.transactions);
    cursor = body.nextCursor;
  } while (cursor);
  return new Map(all.map((transaction) => [transaction.id, transaction]));
}

function insertTransactions(fixture: Fixture, count: number) {
  const insert = fixture.database.query(
    `INSERT INTO plaid_transactions
       (id, plaid_transaction_id, organization_id, plaid_item_record_id,
        account_record_id, name, amount, currency_code, transaction_date,
        pending, source_status, updated_at)
     VALUES (?, ?, 'org_user-1', 'item-report', 'account-report', ?, ?, 'USD',
             '2026-06-01', 0, 'active', '2026-08-31T12:00:00.000Z')`,
  );
  return Array.from({ length: count }, (_, index) => {
    const id = `bulk-${String(index).padStart(4, "0")}`;
    insert.run(id, `plaid-${id}`, `Bulk ${index}`, index + 1);
    return id;
  });
}

describe("transaction changes", () => {
  it("sends every transaction once in pages, then only what changed", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    insertTransactions(fixture, 600);
    const device = await pull(fixture, newDevice());
    expect(device.pages).toBe(2);
    // The listing hides the transaction the bank removed; so does the device.
    expect([...device.transactions.keys()].sort()).toEqual(
      [...(await listing(fixture)).keys()].sort(),
    );
    expect(device.transactions.size).toBe(611);

    const caughtUp = await changes(fixture, device.cursor);
    expect(caughtUp.body).toMatchObject({
      cursor: device.cursor,
      more: false,
      removedIds: [],
      reset: false,
      transactions: [],
    });
  });

  it("reports notes, categories, bank changes, account names, emails, and deletions", async () => {
    const fixture = await createFixture();
    const [first, second, third, fourth, fifth] = seedTransactions(
      fixture.database,
    );
    if (!first || !second || !third || !fourth || !fifth) {
      throw new Error("Missing seeded transactions.");
    }
    const device = await pull(fixture, newDevice());
    const meals = await createCategory(fixture, "Meals");
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/transactions/category",
      "PUT",
      { categoryId: meals, transactionIds: [first] },
    );
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${second}/annotation`,
      "PATCH",
      { labels: ["tax"], note: "Receipt filed", reviewed: true },
    );
    // What a Plaid sync page writes: a modified amount and a removal.
    fixture.database
      .query("UPDATE plaid_transactions SET amount = 99 WHERE id = ?")
      .run(third);
    fixture.database
      .query(
        "UPDATE plaid_transactions SET source_status = 'removed' WHERE id = ?",
      )
      .run(fourth);
    fixture.database.exec(
      "UPDATE plaid_accounts SET name = 'Main operating' WHERE id = 'account-report'",
    );
    fixture.database.exec(`
      INSERT INTO inbound_emails (id, organization_id, envelope_from,
        envelope_to, subject, raw_object_key, raw_size, received_at)
      VALUES ('receipt', 'org_user-1', 'shop@example.com', 'in@example.com',
              'Your receipt', 'raw/receipt', 1, '2026-08-20T00:00:00.000Z');
      INSERT INTO inbound_email_links (id, organization_id, email_id,
        target_type, target_id, created_at)
      VALUES ('link', 'org_user-1', 'receipt', 'finance_transaction',
              '${fifth}', '2026-08-20T00:00:00.000Z');`);

    await pull(fixture, device);
    const shown = (id: string) => device.transactions.get(id);
    expect(shown(first)?.expenseCategoryId).toBe(meals);
    expect(shown(second)?.annotation).toEqual({
      labels: ["tax"],
      note: "Receipt filed",
      reviewed: true,
    });
    expect(shown(third)?.amount).toBe(99);
    expect(shown(fourth)).toBeUndefined();
    expect(shown(fifth)?.accountName).toBe("Main operating");
    expect(shown(fifth)?.linkedEmails).toMatchObject([
      { id: "receipt", status: "inbox", subject: "Your receipt" },
    ]);

    // Archiving the email changes its link; deleting it drops the link.
    fixture.database.exec(
      "UPDATE inbound_emails SET archived_at = '2026-08-21' WHERE id = 'receipt'",
    );
    await pull(fixture, device);
    expect(shown(fifth)?.linkedEmails).toMatchObject([{ status: "archived" }]);
    fixture.database.exec(
      "UPDATE inbound_emails SET deleted_at = '2026-08-22' WHERE id = 'receipt'",
    );
    await pull(fixture, device);
    expect(shown(fifth)?.linkedEmails).toEqual([]);

    // Deleting a bank's data deletes its transactions outright.
    fixture.database
      .query("DELETE FROM plaid_transactions WHERE id = ?")
      .run(fifth);
    await pull(fixture, device);
    expect(shown(fifth)).toBeUndefined();
    expect(new Map(device.transactions)).toEqual(await listing(fixture));
  });

  it("never skips a transaction that changes while a device is paging", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const ids = insertTransactions(fixture, 700);
    const device = newDevice();
    const firstPage = await changes(fixture, null);
    apply(device, firstPage.body);
    expect(firstPage.body.more).toBe(true);
    // One row the device has read, and one it has not reached yet.
    const [read, unread] = [ids[10], ids[650]];
    for (const id of [read, unread]) {
      fixture.database
        .query("UPDATE plaid_transactions SET amount = -1 WHERE id = ?")
        .run(id ?? "");
    }
    await pull(fixture, device);
    expect(device.transactions.get(read ?? "")?.amount).toBe(-1);
    expect(device.transactions.get(unread ?? "")?.amount).toBe(-1);
    expect(new Map(device.transactions)).toEqual(await listing(fixture));
  });

  it("keeps organizations apart, refuses bad cursors, and resets a cursor ahead of the server", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const device = await pull(fixture, newDevice());
    const other = testApp("organization-2", fixture.requestPlaid);
    const foreign = await changes(fixture, null, other);
    expect(foreign.body).toMatchObject({
      cursor: null,
      more: false,
      organizationId: "organization-2",
      transactions: [],
    });
    for (const cursor of ["nope", btoa('["x","y"]')]) {
      expect((await changes(fixture, cursor)).status).toBe(400);
    }
    // A database restored to an earlier point is behind the device's cursor.
    fixture.database.exec(
      "UPDATE finance_sync_revisions SET revision = 3 WHERE organization_id = 'org_user-1'",
    );
    expect((await changes(fixture, device.cursor)).body).toMatchObject({
      cursor: null,
      reset: true,
      transactions: [],
    });
  });

  it("returns the summary without transactions when asked", async () => {
    const fixture = await createFixture();
    seedTransactions(fixture.database);
    const summary = await jsonRequest<{
      accounts: unknown[];
      nextCursor: string | null;
      transactions: unknown[];
    }>(fixture.app, fixture.bindings, "?transactions=none", "GET");
    expect(summary.status).toBe(200);
    expect(summary.body.transactions).toEqual([]);
    expect(summary.body.nextCursor).toBeNull();
    expect(summary.body.accounts).toHaveLength(1);
    const invalid = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "?transactions=all",
      "GET",
    );
    expect(invalid.status).toBe(400);
  });
});

it("purges an organization whose transactions, notes, and email links advance its revisions", async () => {
  const f = maintenanceFixture();
  f.insertActor();
  f.database.exec(`
    INSERT INTO organization (id, name, slug, createdAt, deletedAt)
      VALUES ('purge', 'Purge', 'purge', '2020-01-01', '2020-02-01');
    INSERT INTO plaid_items (id, organization_id, plaid_item_id,
      access_token_ciphertext, access_token_iv, created_by, created_at, updated_at)
      VALUES ('bank', 'purge', 'bank', 'c', 'iv', 'actor', '2020-01-01', '2020-01-01');
    INSERT INTO plaid_accounts (id, plaid_account_id, organization_id,
      plaid_item_record_id, name, type, updated_at)
      VALUES ('account', 'account', 'purge', 'bank', 'Checking', 'depository', '2020-01-01');
    INSERT INTO plaid_transactions (id, plaid_transaction_id, organization_id,
      plaid_item_record_id, account_record_id, name, amount, transaction_date,
      pending, updated_at)
      VALUES ('txn', 'txn', 'purge', 'bank', 'account', 'Coffee', 4, '2020-01-02', 0, '2020-01-02');
    INSERT INTO finance_transaction_annotations (transaction_id, organization_id,
      note, labels, reviewed, created_by, updated_by, created_at, updated_at)
      VALUES ('txn', 'purge', 'note', '[]', 0, 'actor', 'actor', '2020-01-02', '2020-01-02');
    INSERT INTO inbound_emails (id, organization_id, envelope_from, envelope_to,
      raw_object_key, raw_size, received_at)
      VALUES ('email', 'purge', 'a@example.com', 'b@example.com', 'raw', 1, '2020-01-02');
    INSERT INTO inbound_email_links (id, organization_id, email_id, target_type,
      target_id, created_at)
      VALUES ('link', 'purge', 'email', 'finance_transaction', 'txn', '2020-01-02');`);
  expect(
    f.database
      .query(
        "SELECT revision FROM finance_sync_revisions WHERE organization_id = 'purge'",
      )
      .get(),
  ).toEqual({ revision: 3 });
  expect(await purgeDeletedOrganizations(f.bindings, "run-1", now)).toEqual({
    failed: 0,
    purged: 1,
    skipped: 0,
  });
  for (const table of [
    "finance_sync_revisions",
    "finance_sync_tombstones",
    "plaid_transactions",
  ]) {
    expect(
      f.database.query(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    ).toEqual({ count: 0 });
  }
});
