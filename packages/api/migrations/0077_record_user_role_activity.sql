-- Platform role changes made by root admins. Actor snapshots survive changes to
-- the actor; history is removed when the target account is purged.
CREATE TABLE user_role_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('admin_revoked')),
  occurred_at TEXT NOT NULL,
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL
);
CREATE INDEX user_role_events_user_idx ON user_role_events(user_id, occurred_at);
