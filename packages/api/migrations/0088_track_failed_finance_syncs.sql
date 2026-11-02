-- When a connection's sync last failed for good (retries exhausted or a
-- non-retryable Plaid error), beside `last_synced_at` for its last success.
-- Set in the same batch that marks the sync job failed. Backfilled from the
-- sync jobs still recorded; NULL means no failed sync is on record.
ALTER TABLE plaid_items ADD COLUMN last_failed_sync_at TEXT;

UPDATE plaid_items
SET last_failed_sync_at = (
  SELECT MAX(job.finished_at)
  FROM job_runs AS job
  WHERE job.job_id = 'syncFinanceConnection'
    AND job.connection_id = plaid_items.id
    AND job.status = 'failed'
);
