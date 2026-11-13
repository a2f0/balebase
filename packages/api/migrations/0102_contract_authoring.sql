-- Authored source belongs to the same revision as its generated PDF and fields.
ALTER TABLE contracts ADD COLUMN authoring_json TEXT
  CHECK (authoring_json IS NULL OR json_valid(authoring_json));

-- Re-rendering a draft claims the new upload and retires only the replaced PDF.
CREATE TRIGGER replace_authored_contract_document
AFTER UPDATE OF document_object_key ON contracts
WHEN OLD.document_object_key <> NEW.document_object_key
BEGIN
  DELETE FROM deleted_object_cleanup WHERE object_key = NEW.document_object_key;
  INSERT OR IGNORE INTO deleted_object_cleanup
    (id, organization_id, object_key, deleted_at, cleanup_token, cleanup_claimed_at)
  VALUES ('contract-revision:' || OLD.document_object_key, OLD.organization_id,
    OLD.document_object_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL);
END;
