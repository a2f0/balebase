-- Plaid's explanation of a sync failure, shown beside its code on the
-- connection's page. Failures recorded before this migration keep only a code.
ALTER TABLE plaid_items ADD COLUMN error_message TEXT;
