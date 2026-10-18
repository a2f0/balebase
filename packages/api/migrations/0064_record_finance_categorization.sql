-- Record expense category changes atomically, with the category names as
-- snapshots so an event still reads correctly after a rename or delete.
-- Unchanged saves are not events. Earlier assignments cannot be reconstructed.
CREATE TRIGGER activity_finance_category_insert AFTER INSERT ON finance_transaction_annotations
WHEN NEW.expense_category_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'finance_transaction', txn.id,
         COALESCE(txn.merchant_name, txn.name), 'finance_transaction', txn.id,
         'finance.transaction_categorized', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', NULL, 'beforeName', NULL, 'after', NEW.expense_category_id, 'afterName', after_category.name)
  FROM plaid_transactions AS txn JOIN user AS actor ON actor.id = NEW.updated_by
  LEFT JOIN finance_expense_categories AS after_category ON after_category.id = NEW.expense_category_id
  WHERE txn.id = NEW.transaction_id AND txn.organization_id = NEW.organization_id;
END;
CREATE TRIGGER activity_finance_category_update AFTER UPDATE ON finance_transaction_annotations
WHEN NEW.expense_category_id IS NOT OLD.expense_category_id
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'finance_transaction', txn.id,
         COALESCE(txn.merchant_name, txn.name), 'finance_transaction', txn.id,
         'finance.transaction_categorized', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', OLD.expense_category_id, 'beforeName', before_category.name, 'after', NEW.expense_category_id, 'afterName', after_category.name)
  FROM plaid_transactions AS txn JOIN user AS actor ON actor.id = NEW.updated_by
  LEFT JOIN finance_expense_categories AS before_category ON before_category.id = OLD.expense_category_id
  LEFT JOIN finance_expense_categories AS after_category ON after_category.id = NEW.expense_category_id
  WHERE txn.id = NEW.transaction_id AND txn.organization_id = NEW.organization_id;
END;
