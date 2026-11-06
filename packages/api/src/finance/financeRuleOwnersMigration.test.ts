import { expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "../testing/database";

/**
 * Removable once production has applied 0095 (CONTRIBUTING.md, Database):
 * it covers only the backfill of rules and events stored before it.
 */
it("names each earlier rule's creator and the rule behind its applications", () => {
  const database = createTestDatabase({ before: "0095", foreignKeys: false });
  database.exec(`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('dan', 'Dan', 'dan@example.com', 1, '2026', '2026'),
           ('pat', 'Pat', 'pat@example.com', 1, '2026', '2026');
    INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at)
    VALUES ('rule-1', 'org', 'Shell', 'fuel', '2026-11-06T10:00:00.000Z'),
           ('rule-2', 'org', 'Cafe', 'meals', '2026-11-06T11:00:00.000Z');
    INSERT INTO activity_events
      (organization_id, root_type, root_id, root_label, subject_type,
       subject_id, action, actor_user_id, actor_name, actor_email,
       occurred_at, details)
    VALUES
      ('org', 'finance_category', 'fuel', 'Fuel', 'finance_categorization_rule',
       'rule-1', 'finance.categorization_rule_created', 'dan', 'Dan',
       'dan@example.com', '2026-11-06T10:00:00.000Z',
       '{"payeeName":"Shell","categoryId":"fuel","categoryName":"Fuel"}'),
      ('org', 'finance_category', 'fuel', 'Fuel', 'finance_categorization_rule',
       'rule-1', 'finance.categorization_rule_applied', 'dan', 'Dan',
       'dan@example.com', '2026-11-06T10:00:00.000Z',
       '{"payeeName":"Shell","categoryId":"fuel","categoryName":"Fuel","count":1}'),
      -- The transaction that application filled.
      ('org', 'finance_transaction', 'txn-1', 'Shell', 'finance_transaction',
       'txn-1', 'finance.transaction_categorized', 'dan', 'Dan',
       'dan@example.com', '2026-11-06T10:00:00.000Z',
       '{"before":null,"beforeName":null,"after":"fuel","afterName":"Fuel"}'),
      -- Chosen by hand at another moment, and by someone else at the same
      -- one: neither came from the rule.
      ('org', 'finance_transaction', 'txn-2', 'Shell', 'finance_transaction',
       'txn-2', 'finance.transaction_categorized', 'dan', 'Dan',
       'dan@example.com', '2026-11-06T09:00:00.000Z',
       '{"before":null,"beforeName":null,"after":"fuel","afterName":"Fuel"}'),
      ('org', 'finance_transaction', 'txn-3', 'Shell', 'finance_transaction',
       'txn-3', 'finance.transaction_categorized', 'pat', 'Pat',
       'pat@example.com', '2026-11-06T10:00:00.000Z',
       '{"before":null,"beforeName":null,"after":"fuel","afterName":"Fuel"}');
  `);

  applyMigrations(database, { from: "0095" });

  expect(
    database
      .query(
        "SELECT id, created_by FROM finance_categorization_rules ORDER BY id",
      )
      .all(),
  ).toEqual([
    { created_by: "dan", id: "rule-1" },
    // No creation event: no creator is invented.
    { created_by: null, id: "rule-2" },
  ]);
  expect(
    database
      .query(
        `SELECT root_id, details FROM activity_events
         WHERE action = 'finance.transaction_categorized' ORDER BY root_id`,
      )
      .all()
      .map((row) => {
        const { details, root_id } = row as {
          details: string;
          root_id: string;
        };
        return [root_id, JSON.parse(details).ruleId ?? null];
      }),
  ).toEqual([
    ["txn-1", "rule-1"],
    ["txn-2", null],
    ["txn-3", null],
  ]);
});
