import type { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";

/** The annotation table's indexes and triggers, as SQLite stores them. */
function annotationObjects(database: Database) {
  return database
    .query(
      `SELECT type, name, sql FROM sqlite_master
       WHERE tbl_name = 'finance_transaction_annotations'
         AND type IN ('index', 'trigger')
       ORDER BY name`,
    )
    .all();
}

/**
 * Removable once production has applied 0093 (CONTRIBUTING.md, Database):
 * it covers only the rebuild of annotations stored before it.
 */
it("rebuilds annotations with optional editors, keeping rows, indexes, and triggers", () => {
  const database = createTestDatabase({ before: "0093", foreignKeys: false });
  const before = annotationObjects(database);
  database.exec(`
    INSERT INTO finance_transaction_annotations
      (transaction_id, organization_id, note, category_override, labels,
       reviewed, created_by, updated_by, created_at, updated_at,
       expense_category_id)
    VALUES ('txn-1', 'org', 'Kept', 'Old', '["tax"]', 1, 'user-1', 'user-2',
            '2026-01-01', '2026-02-01', 'category-1');`);
  const stored = database
    .query("SELECT * FROM finance_transaction_annotations")
    .all();

  applyMigrations(database, { from: "0093" });

  expect(
    database.query("SELECT * FROM finance_transaction_annotations").all(),
  ).toEqual(stored);
  expect(annotationObjects(database)).toEqual(before);
  // Two indexes, the primary key's, and six triggers.
  expect(before).toHaveLength(9);
  // A rule's write has no editor.
  database.exec(`
    INSERT INTO finance_transaction_annotations
      (transaction_id, organization_id, created_at, updated_at)
    VALUES ('txn-2', 'org', '2026-03-01', '2026-03-01');`);
  expect(
    database
      .query(
        "SELECT created_by, updated_by FROM finance_transaction_annotations WHERE transaction_id = 'txn-2'",
      )
      .get(),
  ).toEqual({ created_by: null, updated_by: null });
});
