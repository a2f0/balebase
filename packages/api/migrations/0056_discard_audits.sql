-- Discarded in-progress audits stay readable, but no longer change.
ALTER TABLE audits ADD COLUMN deleted_at TEXT;

ALTER TABLE audits ADD COLUMN deleted_by_user_id TEXT
  REFERENCES "user" ("id") ON DELETE SET NULL;

CREATE INDEX audits_organization_deleted_created_idx
ON audits (organization_id, deleted_at, created_at DESC);
