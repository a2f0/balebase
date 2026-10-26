ALTER TABLE plaid_items ADD COLUMN daily_sync INTEGER NOT NULL DEFAULT 0 CHECK (daily_sync IN (0, 1));
ALTER TABLE plaid_items ADD COLUMN disconnect_lease_until TEXT;
ALTER TABLE plaid_items ADD COLUMN daily_sync_actor TEXT;
ALTER TABLE plaid_items ADD COLUMN last_daily_sync_date TEXT;

CREATE TABLE finance_sync_settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  previous_daily_sync INTEGER NOT NULL,
  daily_sync INTEGER NOT NULL,
  actor TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TRIGGER finance_daily_sync_history AFTER UPDATE OF daily_sync ON plaid_items
WHEN OLD.daily_sync <> NEW.daily_sync AND NEW.daily_sync_actor IS NOT NULL
BEGIN
  INSERT INTO finance_sync_settings_history
    (connection_id, organization_id, previous_daily_sync, daily_sync, actor, occurred_at)
  VALUES (NEW.id, NEW.organization_id, OLD.daily_sync, NEW.daily_sync, NEW.daily_sync_actor, NEW.updated_at);
END;

CREATE TABLE finance_sync_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'daily')),
  actor TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  initial_cursor TEXT,
  cursor TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  restarts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  available_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX finance_sync_jobs_active ON finance_sync_jobs(connection_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX finance_sync_jobs_connection ON finance_sync_jobs(connection_id, created_at DESC);
CREATE INDEX finance_sync_jobs_pending ON finance_sync_jobs(status, available_at);
CREATE INDEX finance_sync_settings_connection ON finance_sync_settings_history(connection_id, id DESC);
CREATE INDEX plaid_items_daily_sync ON plaid_items(daily_sync, last_daily_sync_date);
