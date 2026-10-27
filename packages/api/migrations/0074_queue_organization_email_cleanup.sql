-- Raw messages and attachments must survive their row cascades as cleanup
-- tombstones, just like uploads, contracts, and employee documents. Keep them
-- in the same transaction as the organization purge and outlive the organization.
CREATE TRIGGER queue_organization_email_cleanup
BEFORE DELETE ON organization
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup
    (id, organization_id, object_key, deleted_at, cleanup_token,
     cleanup_claimed_at)
  SELECT 'inbound-email:' || email.id, email.organization_id,
         email.raw_object_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL
  FROM inbound_emails AS email
  WHERE email.organization_id = OLD.id;

  INSERT OR REPLACE INTO deleted_object_cleanup
    (id, organization_id, object_key, deleted_at, cleanup_token,
     cleanup_claimed_at)
  SELECT 'inbound-attachment:' || attachment.id, email.organization_id,
         attachment.object_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL
  FROM inbound_email_attachments AS attachment
  JOIN inbound_emails AS email ON email.id = attachment.email_id
  WHERE email.organization_id = OLD.id;
END;
