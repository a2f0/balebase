-- Maintenance schedules live in D1 so root admins can edit them. A Cron
-- Trigger runs every minute and queues each enabled job whose cron
-- expression (five fields, UTC) matches that minute. A job without a row
-- runs only on request. The seeded rows keep production's hourly schedule;
-- trashed email stays manual, as before.
CREATE TABLE job_schedules (
  job_id TEXT PRIMARY KEY NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  -- The admin who last changed it as they were then; null for the seed.
  updated_by TEXT,
  updated_by_name TEXT,
  updated_by_email TEXT
);

INSERT INTO job_schedules (job_id, cron, enabled, updated_at)
SELECT job_id, '17 * * * *', enabled, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT 'purgeDeletedOrganizations' AS job_id, 1 AS enabled
  UNION ALL SELECT 'purgeRequestedUsers', 1
  UNION ALL SELECT 'purgeExpiredFreeFormRuns', 1
  UNION ALL SELECT 'purgeDiscardedFormTemplates', 1
  UNION ALL SELECT 'purgeTrashedEmails', 0
  UNION ALL SELECT 'purgeDeletedObjects', 1
  UNION ALL SELECT 'purgePendingFormIssueImages', 1
  UNION ALL SELECT 'purgeStripeWebhookReceipts', 1
  UNION ALL SELECT 'reconcileSubscriptionSeats', 1
  UNION ALL SELECT 'maintainContracts', 1
  UNION ALL SELECT 'refreshCheckrScreenings', 1
);

-- Every schedule change with the admin's snapshot, written in the
-- transaction that makes it. Kept after the admin's account is purged.
CREATE TABLE job_schedule_changes (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  -- Null when the job had no schedule row before.
  previous_cron TEXT,
  previous_enabled INTEGER CHECK (previous_enabled IN (0, 1)),
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL
);
CREATE INDEX job_schedule_changes_history
  ON job_schedule_changes(job_id, changed_at, id);

-- A dry run reports what a maintenance job would change and changes
-- nothing. It never joins, or is joined by, an active real run of the job.
-- Existing rows and the previous Worker's inserts are real runs.
ALTER TABLE job_runs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0
  CHECK (dry_run IN (0, 1));
DROP INDEX job_runs_active;
CREATE UNIQUE INDEX job_runs_active
  ON job_runs(job_id, COALESCE(connection_id, ''), dry_run)
  WHERE status IN ('queued', 'running');
ALTER TABLE maintenance_requests ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0
  CHECK (dry_run IN (0, 1));
