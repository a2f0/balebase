-- Organization API keys for the REST API and the MCP endpoint. Only a SHA-256
-- hash of each token is stored; the token itself is shown once at creation.
-- A key acts as its creator, so it stops working when the creator is no
-- longer an owner or admin of the organization.
CREATE TABLE organization_api_keys (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES user (id) ON DELETE SET NULL
);

CREATE INDEX organization_api_keys_organization_idx
ON organization_api_keys (organization_id, created_at DESC);

CREATE INDEX organization_api_keys_created_by_idx
ON organization_api_keys (created_by);

CREATE TRIGGER activity_api_key_insert AFTER INSERT ON organization_api_keys
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'api_key', NEW.id, NEW.name, 'api_key', NEW.id,
         'api_key.created', actor.id, actor.name, actor.email, NEW.created_at,
         json_object('access', NEW.access, 'prefix', NEW.token_prefix,
                     'expiresAt', NEW.expires_at)
  FROM user AS actor
  WHERE actor.id = NEW.created_by;
END;

CREATE TRIGGER activity_api_key_revoke
AFTER UPDATE OF revoked_at ON organization_api_keys
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'api_key', NEW.id, NEW.name, 'api_key', NEW.id,
         'api_key.revoked', actor.id, actor.name, actor.email, NEW.revoked_at,
         json_object('access', NEW.access, 'prefix', NEW.token_prefix)
  FROM user AS actor
  WHERE actor.id = NEW.revoked_by;
END;
