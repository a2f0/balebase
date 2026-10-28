-- Library, contract, and contract-template uploads are queued for the
-- deleted-object cleanup before they are written, as employee forms (0045)
-- and screening consents (0067) are. The row that references an upload
-- claims it, so an upload whose row is never written is purged.
CREATE TRIGGER clear_completed_library_upload
AFTER INSERT ON objects
WHEN NEW.kind = 'library'
BEGIN
  DELETE FROM deleted_object_cleanup WHERE object_key = NEW.object_key;
END;

CREATE TRIGGER clear_completed_contract_upload
AFTER INSERT ON contracts
BEGIN
  DELETE FROM deleted_object_cleanup
  WHERE object_key = NEW.document_object_key;
END;

CREATE TRIGGER clear_completed_contract_final_upload
AFTER UPDATE OF final_object_key ON contracts
WHEN NEW.final_object_key IS NOT NULL
BEGIN
  DELETE FROM deleted_object_cleanup
  WHERE object_key = NEW.final_object_key;
END;

CREATE TRIGGER clear_completed_contract_template_upload
AFTER INSERT ON contract_template_versions
BEGIN
  DELETE FROM deleted_object_cleanup
  WHERE object_key = NEW.document_object_key;
END;
