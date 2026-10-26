CREATE TABLE job_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  connection_id TEXT REFERENCES plaid_items(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'daily', 'scheduled')),
  requested_by TEXT,
  cron TEXT,
  scheduled_time INTEGER,
  depends_on TEXT REFERENCES job_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  available_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  -- Finance checkpoints are private handler state, never part of the admin response.
  initial_cursor TEXT,
  cursor TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  CHECK (job_id <> 'syncFinanceConnection' OR (connection_id IS NOT NULL AND organization_id IS NOT NULL))
);

INSERT INTO job_runs
  (id, job_id, connection_id, organization_id, source, requested_by, status,
   initial_cursor, cursor, added, modified, removed, pages, failures, restarts,
   lease_until, available_at, error_code, error_message, created_at, finished_at, output_json)
SELECT id, 'syncFinanceConnection', connection_id, organization_id, source, requested_by, status,
  initial_cursor, cursor, added, modified, removed, pages, failures, restarts,
  lease_until, available_at, error_code, error_message, created_at, finished_at,
  json_object('added', added, 'modified', modified, 'removed', removed, 'pages', pages, 'restarts', restarts)
FROM finance_sync_jobs;
DROP TABLE finance_sync_jobs;

CREATE UNIQUE INDEX job_runs_active ON job_runs(job_id, COALESCE(connection_id, ''))
  WHERE status IN ('queued', 'running');
CREATE INDEX job_runs_history ON job_runs(created_at DESC, id DESC);
CREATE INDEX job_runs_kind_history ON job_runs(job_id, created_at DESC, id DESC);
CREATE INDEX job_runs_connection ON job_runs(connection_id, created_at DESC);
CREATE INDEX job_runs_organization ON job_runs(organization_id);
CREATE INDEX job_runs_pending ON job_runs(status, available_at);
CREATE INDEX job_runs_retention ON job_runs(finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX job_runs_dependency ON job_runs(depends_on);

CREATE TABLE job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  message TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json))
);
CREATE INDEX job_logs_run ON job_logs(run_id, id);

INSERT INTO job_logs (run_id, occurred_at, level, message, details_json)
SELECT id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'info',
  'Imported existing bank sync; earlier logs, start time, and attempt count are unavailable.',
  json_object('status', status) FROM job_runs;

-- Log lifecycle changes atomically, including cancellations outside the consumer.
CREATE TRIGGER job_runs_created AFTER INSERT ON job_runs
BEGIN
  INSERT INTO job_logs (run_id, occurred_at, level, message, details_json)
  VALUES (NEW.id, NEW.created_at, 'info', 'Job queued.', json_object('source', NEW.source));
END;

CREATE TRIGGER job_runs_progress AFTER UPDATE ON job_runs
WHEN OLD.status <> NEW.status OR OLD.attempts <> NEW.attempts
  OR OLD.pages <> NEW.pages OR OLD.restarts <> NEW.restarts
BEGIN
  INSERT INTO job_logs (run_id, occurred_at, level, message, details_json)
  VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE WHEN NEW.status = 'failed' THEN 'error'
      WHEN NEW.error_code IS NOT NULL THEN 'warn' ELSE 'info' END,
    CASE WHEN NEW.status = 'succeeded' THEN 'Job completed.'
      WHEN NEW.status = 'failed' THEN 'Job failed; some work may have completed.'
      WHEN NEW.status = 'cancelled' THEN 'Job cancelled.'
      WHEN NEW.restarts > OLD.restarts THEN 'Bank pagination restarted.'
      WHEN NEW.pages > OLD.pages THEN 'Bank page saved.'
      WHEN NEW.status = 'running' THEN 'Attempt started.'
      ELSE 'Job waiting for another attempt.' END,
    json_object('status', NEW.status, 'attempt', NEW.attempts, 'errorCode', NEW.error_code,
      'availableAt', NEW.available_at, 'output', json(NEW.output_json)));
END;
