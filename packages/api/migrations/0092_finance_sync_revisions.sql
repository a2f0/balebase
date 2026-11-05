-- Devices keep every transaction of an organization and catch up from one
-- cursor per organization (GET /api/finance/transactions/changes).
--
-- The cursor is a counter, never a timestamp: each organization has one row
-- here, and every change to what a device shows for a transaction advances it
-- inside the writing statement. D1 serializes writes, so revisions follow
-- commit order and a reader that has seen revision R has seen every change at
-- or below R. A Worker clock could not promise that (isolates are skewed, and
-- a slow write could commit with an older time than one already read).
--
-- Plaid interruptions need nothing special: a sync page that is retried,
-- resumed from its saved Plaid cursor, or restarted after
-- TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION rewrites its rows, and each
-- rewrite takes a new revision, so devices read them again.
--
-- Cursors also carry `epoch`. Restoring D1 to an earlier point moves the
-- counter back, and it can then climb past a device's cursor along another
-- history; rotating every epoch after a restore (docs/operations.md) makes
-- those devices start over instead of keeping what the restore undid.
CREATE TABLE finance_sync_revisions (
  organization_id TEXT NOT NULL PRIMARY KEY
    REFERENCES organization (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  epoch TEXT NOT NULL DEFAULT (lower(hex(randomblob(8))))
);

-- Transactions deleted outright (a disconnected bank's data deletion), so
-- devices drop them too. Removed-by-Plaid rows stay as `source_status =
-- 'removed'` and are reported from plaid_transactions itself.
CREATE TABLE finance_sync_tombstones (
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (organization_id, transaction_id)
);

CREATE INDEX finance_sync_tombstones_revision
  ON finance_sync_tombstones (organization_id, revision, transaction_id);

ALTER TABLE plaid_transactions ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0;

-- Existing transactions take revisions 1..n per organization before the
-- triggers exist, so the backfill records nothing twice.
UPDATE plaid_transactions
SET sync_revision = (
  SELECT numbered.revision FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY organization_id ORDER BY transaction_date, id
    ) AS revision
    FROM plaid_transactions
  ) AS numbered
  WHERE numbered.id = plaid_transactions.id
);

INSERT INTO finance_sync_revisions (organization_id, revision)
SELECT organization_id, MAX(sync_revision)
FROM plaid_transactions
GROUP BY organization_id;

CREATE INDEX plaid_transactions_sync_revision
  ON plaid_transactions (organization_id, sync_revision, id);

-- Every trigger advances the counter only while the organization exists: an
-- organization purge deletes the organization row first and cascades to its
-- transactions and links afterwards, and a counter row for it would then
-- fail the foreign key and abort the purge.

-- A new or changed transaction takes the next revision. The trigger's own
-- write changes sync_revision, which the WHEN clause skips.
CREATE TRIGGER finance_sync_transaction_insert AFTER INSERT ON plaid_transactions
WHEN EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER finance_sync_transaction_update AFTER UPDATE ON plaid_transactions
WHEN NEW.sync_revision IS OLD.sync_revision
  AND EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER finance_sync_transaction_delete AFTER DELETE ON plaid_transactions
WHEN EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (OLD.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO finance_sync_tombstones (organization_id, transaction_id, revision)
  SELECT OLD.organization_id, OLD.id, revision
  FROM finance_sync_revisions WHERE organization_id = OLD.organization_id
  ON CONFLICT (organization_id, transaction_id)
  DO UPDATE SET revision = excluded.revision;
END;

-- Notes, labels, review state, and expense categories.
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

-- Transactions show their account's name.
CREATE TRIGGER finance_sync_account_rename AFTER UPDATE OF name ON plaid_accounts
WHEN NEW.name IS NOT OLD.name
  AND EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
  AND EXISTS (SELECT 1 FROM plaid_transactions WHERE account_record_id = NEW.id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE account_record_id = NEW.id;
END;

-- Transactions list their linked emails, with each email's subject and
-- folder; a deleted email drops out of the list.
CREATE TRIGGER finance_sync_email_link_insert AFTER INSERT ON inbound_email_links
WHEN NEW.target_type = 'finance_transaction'
  AND EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE id = NEW.target_id AND organization_id = NEW.organization_id;
END;

CREATE TRIGGER finance_sync_email_link_delete AFTER DELETE ON inbound_email_links
WHEN OLD.target_type = 'finance_transaction'
  AND EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id)
  AND EXISTS (SELECT 1 FROM plaid_transactions
              WHERE id = OLD.target_id AND organization_id = OLD.organization_id)
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (OLD.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = OLD.organization_id)
  WHERE id = OLD.target_id AND organization_id = OLD.organization_id;
END;

CREATE TRIGGER finance_sync_linked_email_update
AFTER UPDATE OF subject, archived_at, deleted_at ON inbound_emails
WHEN (NEW.subject IS NOT OLD.subject OR NEW.archived_at IS NOT OLD.archived_at
      OR NEW.deleted_at IS NOT OLD.deleted_at)
  AND EXISTS (SELECT 1 FROM organization WHERE id = NEW.organization_id)
  AND EXISTS (SELECT 1 FROM inbound_email_links
              WHERE email_id = NEW.id AND target_type = 'finance_transaction')
BEGIN
  INSERT INTO finance_sync_revisions (organization_id, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO UPDATE SET revision = revision + 1;
  UPDATE plaid_transactions
  SET sync_revision = (SELECT revision FROM finance_sync_revisions
                       WHERE organization_id = NEW.organization_id)
  WHERE organization_id = NEW.organization_id
    AND id IN (SELECT target_id FROM inbound_email_links
               WHERE email_id = NEW.id AND target_type = 'finance_transaction');
END;
