-- Deleting a disconnected connection's imported data removes the connection
-- row, which still erases that connection's earlier activity. The deletion
-- itself is recorded in the same batch, after its counts are read, and must
-- survive the purge it describes, so this trigger now keeps that one action.
-- The trigger is replaced within this migration, so the previous Worker's
-- deletes keep removing the same history they did before.
DROP TRIGGER activity_finance_connection_delete;

CREATE TRIGGER activity_finance_connection_delete AFTER DELETE ON plaid_items
BEGIN
  DELETE FROM activity_events
  WHERE root_type = 'finance_connection' AND root_id = OLD.id
    AND action <> 'finance.connection_data_deleted';
END;
