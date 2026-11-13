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

/** Removable once production has applied 0100: exercises pre-mode rule rows. */
it("adds exact matching to existing rules without changing their unique payees", () => {
  const database = createTestDatabase({ before: "0100", foreignKeys: false });
  database.exec(`
    INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at)
    VALUES ('old-rule', 'org', 'Shell', 'fuel', '2026-01-01');`);
  const indexes = database.query(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'index' AND tbl_name = 'finance_categorization_rules'
     ORDER BY name`,
  );
  const before = indexes.all();

  applyMigrations(database, { from: "0100" });

  expect(indexes.all()).toEqual(before);
  expect(
    database
      .query("SELECT * FROM finance_categorization_rules WHERE id = 'old-rule'")
      .get(),
  ).toEqual({
    created_at: "2026-01-01",
    created_by: null,
    expense_category_id: "fuel",
    id: "old-rule",
    match_type: "exact",
    organization_id: "org",
    payee_name: "Shell",
  });
  const insert = database.query(
    `INSERT INTO finance_categorization_rules
       (id, organization_id, payee_name, expense_category_id, created_at, match_type)
     VALUES (?, 'org', ?, 'fuel', '2026', ?)`,
  );
  for (const matchType of ["exact", "startsWith", "contains"]) {
    insert.run(matchType, matchType, matchType);
  }
  expect(() => insert.run("duplicate", "Shell", "contains")).toThrow();
  expect(() => insert.run("invalid", "Other", "endsWith")).toThrow();
  expect(() => insert.run("null", "Other", null)).toThrow();
  database.exec(`
    INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at)
    VALUES ('schema-default', 'org', 'Cafe', 'meals', '2026');`);
  expect(
    database
      .query(
        "SELECT match_type FROM finance_categorization_rules WHERE id = 'schema-default'",
      )
      .get(),
  ).toEqual({ match_type: "exact" });
});
