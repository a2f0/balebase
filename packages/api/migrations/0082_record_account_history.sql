-- Platform role history also records `auth:set-role`, whose operator is not a
-- Balebase user: operator events keep the operator's own label and no user ID.
-- The rebuild keeps every column and default the previous Worker writes.
CREATE TABLE user_role_events_next (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('admin_revoked', 'role_set')),
  occurred_at TEXT NOT NULL,
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'operator')),
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);
INSERT INTO user_role_events_next
  (id, user_id, action, occurred_at, previous_role, new_role,
   actor_kind, actor_user_id, actor_name, actor_email)
SELECT id, user_id, action, occurred_at, previous_role, new_role,
  'user', actor_user_id, actor_name, actor_email
FROM user_role_events;
DROP TABLE user_role_events;
ALTER TABLE user_role_events_next RENAME TO user_role_events;
CREATE INDEX user_role_events_user_idx ON user_role_events(user_id, occurred_at);

-- `auth:set-role` inserts one row here. D1 has no explicit transactions, so the
-- trigger makes the event and the role change one statement: either both
-- happen or neither does, and setting the current role changes nothing.
CREATE VIEW operator_role_changes AS
SELECT NULL AS email, NULL AS role, NULL AS operator_name, NULL AS operator_email
WHERE 0;
CREATE TRIGGER operator_role_change INSTEAD OF INSERT ON operator_role_changes
BEGIN
  SELECT RAISE(ABORT, 'Role must be either user or admin.')
  WHERE NEW.role IS NULL OR NEW.role NOT IN ('user', 'admin');
  SELECT RAISE(ABORT, 'The operator must be named.')
  WHERE trim(COALESCE(NEW.operator_name, '')) = '';
  SELECT RAISE(ABORT, 'No user has that email.')
  WHERE NOT EXISTS (SELECT 1 FROM user WHERE email = NEW.email);
  INSERT INTO user_role_events
    (id, user_id, action, occurred_at, previous_role, new_role,
     actor_kind, actor_user_id, actor_name, actor_email)
  SELECT lower(hex(randomblob(16))), id, 'role_set',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), COALESCE(role, ''), NEW.role,
    'operator', NULL, trim(NEW.operator_name), trim(COALESCE(NEW.operator_email, ''))
  FROM user WHERE email = NEW.email AND role IS NOT NEW.role;
  UPDATE user SET role = NEW.role WHERE email = NEW.email AND role IS NOT NEW.role;
END;

-- Manual maintenance requests. The run keeps the first requester's snapshot;
-- this history keeps every request, including ones that joined an active run,
-- after job history expires and after the requester's account is purged.
ALTER TABLE job_runs ADD COLUMN requested_by_name TEXT;
ALTER TABLE job_runs ADD COLUMN requested_by_email TEXT;
CREATE TABLE maintenance_requests (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  joined_active_run INTEGER NOT NULL CHECK (joined_active_run IN (0, 1)),
  requested_at TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL
);
CREATE INDEX maintenance_requests_history ON maintenance_requests(requested_at, id);

-- A person's own security changes. Better Auth writes them through its adapter,
-- so triggers record each change in the statement that makes it. Every remaining
-- writer is the account holder's own session or password reset link: the admin
-- endpoints that could set passwords or update users are disabled.
CREATE TABLE user_security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('two_factor_enabled', 'two_factor_disabled', 'password_changed')),
  occurred_at TEXT NOT NULL
);
CREATE INDEX user_security_events_user_idx ON user_security_events(user_id, id);

CREATE TRIGGER user_security_two_factor AFTER UPDATE OF twoFactorEnabled ON user
WHEN COALESCE(OLD.twoFactorEnabled, 0) <> COALESCE(NEW.twoFactorEnabled, 0)
BEGIN
  INSERT INTO user_security_events (user_id, action, occurred_at)
  VALUES (NEW.id,
    CASE WHEN COALESCE(NEW.twoFactorEnabled, 0) THEN 'two_factor_enabled' ELSE 'two_factor_disabled' END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER user_security_password AFTER UPDATE OF password ON account
WHEN NEW.providerId = 'credential' AND OLD.password IS NOT NEW.password
BEGIN
  INSERT INTO user_security_events (user_id, action, occurred_at)
  VALUES (NEW.userId, 'password_changed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
