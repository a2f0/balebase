-- Retain the acknowledgment even when members empty the mailbox. A queued
-- delivery always refers to the binding validated in its SMTP transaction.
CREATE TABLE inbound_smtp_receipts (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES inbound_mailboxes(id) ON DELETE CASCADE
);
CREATE INDEX inbound_smtp_receipts_by_mailbox ON inbound_smtp_receipts(mailbox_id);
