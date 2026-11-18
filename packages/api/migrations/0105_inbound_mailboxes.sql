-- Pending requests do not reserve names. Only one tenant can verify a domain.
CREATE TABLE inbound_domains (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE (organization_id, domain)
);
CREATE UNIQUE INDEX inbound_verified_domain ON inbound_domains(domain)
WHERE verified_at IS NOT NULL;

-- One named mailbox for each exact recipient. An unbound mailbox retains
-- its messages, but the Worker no longer accepts either of its addresses.
CREATE TABLE inbound_mailboxes (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  forwarding_id TEXT NOT NULL UNIQUE,
  disconnected_at TEXT
);
CREATE UNIQUE INDEX inbound_bound_address ON inbound_mailboxes(address)
WHERE disconnected_at IS NULL;
CREATE INDEX inbound_mailboxes_by_org ON inbound_mailboxes(organization_id);
-- NULL denotes the organization's existing upload inbox, including old mail.
ALTER TABLE inbound_emails ADD COLUMN mailbox_id TEXT REFERENCES inbound_mailboxes(id);
CREATE INDEX inbound_mailbox_received ON inbound_emails(organization_id, mailbox_id, received_at);

CREATE TRIGGER clear_completed_inbound_message_upload
AFTER INSERT ON inbound_emails
BEGIN
  DELETE FROM deleted_object_cleanup WHERE object_key = NEW.raw_object_key;
END;
CREATE TRIGGER clear_completed_inbound_attachment_upload
AFTER INSERT ON inbound_email_attachments
BEGIN
  DELETE FROM deleted_object_cleanup WHERE object_key = NEW.object_key;
END;
