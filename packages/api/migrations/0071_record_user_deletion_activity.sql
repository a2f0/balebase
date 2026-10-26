ALTER TABLE user_deletion_requests ADD COLUMN requested_by_user_id TEXT;
ALTER TABLE user_deletion_requests ADD COLUMN requested_by_name TEXT;
ALTER TABLE user_deletion_requests ADD COLUMN requested_by_email TEXT;

-- Global account history is restricted to database operators. Actor snapshots
-- survive changes to the actor; history is removed when the target is purged.
CREATE TABLE user_deletion_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('requested', 'canceled')),
  occurred_at TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL
);
CREATE INDEX user_deletion_events_user_idx ON user_deletion_events(user_id, occurred_at);
