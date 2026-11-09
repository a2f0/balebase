-- Businesses are deleted softly: a deleted business is hidden and
-- restorable, and keeps its history. It keeps its EIN and DUNS number too,
-- so the organization's unique identifiers still hold and a restore never
-- collides. Only purging the organization removes the row.
ALTER TABLE businesses ADD COLUMN deleted_at TEXT;
ALTER TABLE businesses ADD COLUMN deleted_by_user_id TEXT
  REFERENCES user (id) ON DELETE SET NULL;

CREATE INDEX businesses_organization_deleted_idx
ON businesses (organization_id, deleted_at);
