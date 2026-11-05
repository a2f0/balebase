import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";

/**
 * Removable once production has applied 0092 (CONTRIBUTING.md, Database):
 * it covers only the backfill of transactions imported before it.
 */
it("numbers existing transactions per organization and continues from there", () => {
  const database = createTestDatabase({ before: "0092", foreignKeys: false });
  database.exec(`
    INSERT INTO organization (id, name, slug, createdAt)
      VALUES ('one', 'One', 'one', '2026-01-01'),
             ('two', 'Two', 'two', '2026-01-01'),
             ('empty', 'Empty', 'empty', '2026-01-01');`);
  const insert = database.query(
    `INSERT INTO plaid_transactions (id, plaid_transaction_id, organization_id,
       plaid_item_record_id, account_record_id, name, amount, transaction_date,
       pending, source_status, updated_at)
     VALUES (?, ?, ?, 'item', 'account', 'Row', 1, ?, 0, ?, '2026-01-01')`,
  );
  for (const [id, organization, date, status] of [
    ["one-b", "one", "2026-02-01", "active"],
    ["one-a", "one", "2026-02-01", "removed"],
    ["one-c", "one", "2026-01-15", "active"],
    ["two-a", "two", "2026-03-01", "active"],
  ] as const) {
    insert.run(id, id, organization, date, status);
  }

  applyMigrations(database, { from: "0092" });

  // Oldest first by date, then ID; removed rows are numbered too, so
  // devices learn to drop them.
  expect(
    database
      .query(
        "SELECT id, sync_revision FROM plaid_transactions ORDER BY organization_id, sync_revision",
      )
      .all(),
  ).toEqual([
    { id: "one-c", sync_revision: 1 },
    { id: "one-a", sync_revision: 2 },
    { id: "one-b", sync_revision: 3 },
    { id: "two-a", sync_revision: 1 },
  ]);
  expect(
    database
      .query(
        "SELECT organization_id, revision FROM finance_sync_revisions ORDER BY organization_id",
      )
      .all(),
  ).toEqual([
    { organization_id: "one", revision: 3 },
    { organization_id: "two", revision: 1 },
  ]);

  // The next change continues each organization's counter.
  database.exec("UPDATE plaid_transactions SET amount = 2 WHERE id = 'one-c'");
  insert.run("empty-a", "empty-a", "empty", "2026-04-01", "active");
  expect(
    database
      .query(
        "SELECT id, sync_revision FROM plaid_transactions WHERE id IN ('one-c', 'empty-a') ORDER BY id",
      )
      .all(),
  ).toEqual([
    { id: "empty-a", sync_revision: 1 },
    { id: "one-c", sync_revision: 4 },
  ]);
});
