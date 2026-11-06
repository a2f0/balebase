-- Categorization rules give a payee's transactions an expense category: a
-- transaction matches when the name it is shown under (the merchant, else the
-- bank's description) equals the rule's payee name exactly. One rule per payee
-- name, so at most one rule matches any transaction. Rules fill only
-- uncategorized transactions; they never replace a category someone chose.
CREATE TABLE finance_categorization_rules (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  payee_name TEXT NOT NULL CHECK (length(payee_name) BETWEEN 1 AND 200),
  -- Deleting a category deletes its rules; the API records each one first.
  expense_category_id TEXT NOT NULL
    REFERENCES finance_expense_categories (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX finance_categorization_rules_payee_idx
ON finance_categorization_rules (organization_id, payee_name);

CREATE INDEX finance_categorization_rules_category_idx
ON finance_categorization_rules (expense_category_id);

-- A rule that categorizes a newly imported transaction is Balebase's work,
-- not a person's: its annotation has no creator or last editor, and the sync
-- records a system event for it. Making created_by and updated_by nullable
-- rebuilds the table. The previous Worker always sets both, so its writes
-- satisfy the new table during the deploy window.
--
-- Nothing references this table by foreign key, and no other table's trigger
-- names it; the legacy rename keeps the rebuild independent of other
-- triggers all the same (supported by D1:
-- developers.cloudflare.com/d1/sql-api/sql-statements).
CREATE TABLE finance_transaction_annotations_next (
  transaction_id TEXT NOT NULL PRIMARY KEY
    REFERENCES plaid_transactions (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  category_override TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES user (id) ON DELETE RESTRICT,
  updated_by TEXT REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expense_category_id TEXT
    REFERENCES finance_expense_categories (id) ON DELETE SET NULL
);

INSERT INTO finance_transaction_annotations_next (
  transaction_id, organization_id, note, category_override, labels, reviewed,
  created_by, updated_by, created_at, updated_at, expense_category_id
)
SELECT
  transaction_id, organization_id, note, category_override, labels, reviewed,
  created_by, updated_by, created_at, updated_at, expense_category_id
FROM finance_transaction_annotations;

PRAGMA legacy_alter_table = ON;
DROP TABLE finance_transaction_annotations;
ALTER TABLE finance_transaction_annotations_next
  RENAME TO finance_transaction_annotations;
PRAGMA legacy_alter_table = OFF;

-- The indexes and triggers went with the old table; these are their latest
-- definitions (0009, 0034, 0063, 0064, and 0092). The activity triggers join
-- the editor's user row, so a rule's write (no editor) records nothing there.
CREATE INDEX finance_transaction_annotations_category_idx
ON finance_transaction_annotations (organization_id, expense_category_id);

CREATE INDEX finance_transaction_annotations_organization_idx
ON finance_transaction_annotations (organization_id, updated_at DESC);

CREATE TRIGGER activity_finance_annotation_insert AFTER INSERT ON finance_transaction_annotations
WHEN NEW.note <> '' OR NEW.labels <> '[]' OR NEW.reviewed <> 0
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'finance_transaction', txn.id,
         COALESCE(txn.merchant_name, txn.name), 'finance_transaction', txn.id,
         'finance.transaction_annotated', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', json_object('note', '', 'labels', json('[]'), 'reviewed', json('false')), 'after', json_object('note', NEW.note, 'labels', json(NEW.labels), 'reviewed', json(CASE WHEN NEW.reviewed = 1 THEN 'true' ELSE 'false' END)))
  FROM plaid_transactions AS txn JOIN user AS actor ON actor.id = NEW.updated_by
  WHERE txn.id = NEW.transaction_id AND txn.organization_id = NEW.organization_id;
END;

CREATE TRIGGER activity_finance_annotation_update AFTER UPDATE ON finance_transaction_annotations
WHEN NEW.note IS NOT OLD.note OR NEW.labels IS NOT OLD.labels OR NEW.reviewed IS NOT OLD.reviewed
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'finance_transaction', txn.id,
         COALESCE(txn.merchant_name, txn.name), 'finance_transaction', txn.id,
         'finance.transaction_annotated', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', json_object('note', OLD.note, 'labels', json(OLD.labels), 'reviewed', json(CASE WHEN OLD.reviewed = 1 THEN 'true' ELSE 'false' END)), 'after', json_object('note', NEW.note, 'labels', json(NEW.labels), 'reviewed', json(CASE WHEN NEW.reviewed = 1 THEN 'true' ELSE 'false' END)))
  FROM plaid_transactions AS txn JOIN user AS actor ON actor.id = NEW.updated_by
  WHERE txn.id = NEW.transaction_id AND txn.organization_id = NEW.organization_id;
END;

CREATE TRIGGER activity_finance_category_insert AFTER INSERT ON finance_transaction_annotations
WHEN NEW.expense_category_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'finance_transaction', txn.id,
         COALESCE(txn.merchant_name, txn.name), 'finance_transaction', txn.id,
         'finance.transaction_categorized', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', NULL, 'beforeName', NULL, 'after', NEW.expense_category_id, 'afterName', after_category.name)
  FROM plaid_transactions AS txn JOIN user AS actor ON actor.id = NEW.updated_by
  LEFT JOIN finance_expense_categories AS after_category ON after_category.id = NEW.expense_category_id
  WHERE txn.id = NEW.transaction_id AND txn.organization_id = NEW.organization_id;
END;

CREATE TRIGGER activity_finance_category_update AFTER UPDATE ON finance_transaction_annotations
WHEN NEW.expense_category_id IS NOT OLD.expense_category_id
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'finance_transaction', txn.id,
         COALESCE(txn.merchant_name, txn.name), 'finance_transaction', txn.id,
         'finance.transaction_categorized', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', OLD.expense_category_id, 'beforeName', before_category.name, 'after', NEW.expense_category_id, 'afterName', after_category.name)
  FROM plaid_transactions AS txn JOIN user AS actor ON actor.id = NEW.updated_by
  LEFT JOIN finance_expense_categories AS before_category ON before_category.id = OLD.expense_category_id
  LEFT JOIN finance_expense_categories AS after_category ON after_category.id = NEW.expense_category_id
  WHERE txn.id = NEW.transaction_id AND txn.organization_id = NEW.organization_id;
END;

CREATE TRIGGER finance_sync_annotation_insert AFTER INSERT ON finance_transaction_annotations
WHEN EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE id = NEW.transaction_id AND organization_id = NEW.organization_id;
END;

CREATE TRIGGER finance_sync_annotation_update AFTER UPDATE ON finance_transaction_annotations
WHEN (NEW.note IS NOT OLD.note OR NEW.labels IS NOT OLD.labels
      OR NEW.reviewed IS NOT OLD.reviewed
      OR NEW.expense_category_id IS NOT OLD.expense_category_id)
  AND EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE id = NEW.transaction_id AND organization_id = NEW.organization_id;
END;
