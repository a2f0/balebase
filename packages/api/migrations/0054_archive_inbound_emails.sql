ALTER TABLE inbound_emails ADD COLUMN archived_at TEXT;

CREATE INDEX inbound_emails_organization_archived_received_idx
ON inbound_emails (organization_id, archived_at, received_at DESC)
WHERE deleted_at IS NULL;
