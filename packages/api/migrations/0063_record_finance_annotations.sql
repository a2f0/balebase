-- Record annotation edits atomically; category-only writes and unchanged saves
-- are not annotation events. Earlier edits cannot be reconstructed.
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
