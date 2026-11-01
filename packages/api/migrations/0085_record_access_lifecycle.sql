-- API keys stay stopped. A key acts as its creator, so it stops when the
-- creator is no longer an owner or admin. It used to resume, unrecorded, when
-- they regained the role or rejoined. Now the change that stops a key revokes
-- it: a role change below admin (here), and removal or leaving (the batch in
-- organizations/memberRemoval.ts). revoked_reason says why; it is NULL when a
-- manager revoked the key on the API keys page.
ALTER TABLE organization_api_keys ADD COLUMN revoked_reason TEXT
  CHECK (revoked_reason IS NULL OR revoked_reason IN (
    'role_changed', 'member_removed', 'member_left', 'creator_access_ended'));

-- Keys whose creator had already lost the role or left before this migration
-- stopped then, unrecorded, with no actor this migration could name. Mark
-- them revoked so they cannot resume; they record no event and no revoker.
UPDATE organization_api_keys
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    revoked_reason = 'creator_access_ended'
WHERE revoked_at IS NULL
  AND (expires_at IS NULL
       OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  AND NOT EXISTS (
    SELECT 1 FROM member
    WHERE member.organizationId = organization_api_keys.organization_id
      AND member.userId = organization_api_keys.created_by
      AND (instr(',' || replace(member.role, ' ', '') || ',', ',owner,') > 0
           OR instr(',' || replace(member.role, ' ', '') || ',', ',admin,') > 0)
  );

-- As in 0060, with the reason a key was revoked.
DROP TRIGGER activity_api_key_revoke;
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
         json_object('access', NEW.access, 'prefix', NEW.token_prefix,
                     'reason', NEW.revoked_reason)
  FROM user AS actor
  WHERE actor.id = NEW.revoked_by;
END;

-- As in 0057, and a change that leaves the person neither owner nor admin
-- revokes the unexpired keys they made here, named in the role event. The
-- revocations record `api_key.revoked` (above) with the same actor.
DROP TRIGGER activity_member_role_update;
CREATE TRIGGER activity_member_role_update
AFTER UPDATE OF role, activity_actor_id ON member
WHEN NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organizationId, 'organization_member', NEW.id, affected.name,
         'organization_member', NEW.id, 'organization.member_role_changed',
         actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('before', OLD.role, 'after', NEW.role,
                     'userId', affected.id, 'userName', affected.name,
                     'userEmail', affected.email,
                     'revokedApiKeys', json((
                       SELECT json_group_array(
                                json_object('id', id, 'name', name))
                       FROM (
                         SELECT id, name FROM organization_api_keys
                         WHERE organization_id = NEW.organizationId
                           AND created_by = NEW.userId
                           AND revoked_at IS NULL
                           AND (expires_at IS NULL OR expires_at >
                                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                           AND instr(',' || replace(NEW.role, ' ', '') || ',',
                                     ',owner,') = 0
                           AND instr(',' || replace(NEW.role, ' ', '') || ',',
                                     ',admin,') = 0
                         ORDER BY created_at, id
                       )
                     )))
  FROM user AS actor
  JOIN user AS affected ON affected.id = NEW.userId
  WHERE actor.id = NEW.activity_actor_id AND NEW.role <> OLD.role;

  UPDATE organization_api_keys
  SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      revoked_by = NEW.activity_actor_id,
      revoked_reason = 'role_changed'
  WHERE organization_id = NEW.organizationId
    AND created_by = NEW.userId
    AND revoked_at IS NULL
    AND (expires_at IS NULL
         OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND NEW.role <> OLD.role
    AND instr(',' || replace(NEW.role, ' ', '') || ',', ',owner,') = 0
    AND instr(',' || replace(NEW.role, ' ', '') || ',', ',admin,') = 0
    AND EXISTS (SELECT 1 FROM user WHERE id = NEW.activity_actor_id);

  -- Do not attribute a later maintenance update to this request's actor.
  UPDATE member SET activity_actor_id = NULL WHERE id = NEW.id;
END;

-- Creating an organization, at sign-up or from the organization switcher,
-- records `organization.created` in the same write. The creator is its
-- founding owner; activity_created_via says which path made it.
ALTER TABLE organization ADD COLUMN activity_created_via TEXT
  CHECK (activity_created_via IS NULL
         OR activity_created_via IN ('signup', 'create'));

CREATE TRIGGER activity_organization_insert AFTER INSERT ON organization
WHEN NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.id, 'organization', NEW.id, NEW.name, 'organization', NEW.id,
         'organization.created', actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('name', NEW.name, 'slug', NEW.slug,
                     'via', NEW.activity_created_via,
                     'ownerId', actor.id, 'ownerName', actor.name,
                     'ownerEmail', actor.email)
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id;

  UPDATE organization
  SET activity_actor_id = NULL, activity_created_via = NULL
  WHERE id = NEW.id;
END;

-- A person's own account history (0082) also records replacing the
-- authenticator app, regenerating backup codes, and profile name and picture
-- changes. The table is rebuilt to widen its action list and add details; the
-- 0082 triggers are recreated unchanged around it.
DROP TRIGGER user_security_two_factor;
DROP TRIGGER user_security_password;

CREATE TABLE user_security_events_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'two_factor_enabled', 'two_factor_disabled', 'password_changed',
    'two_factor_authenticator_replaced', 'two_factor_backup_codes_regenerated',
    'name_changed', 'image_changed')),
  occurred_at TEXT NOT NULL,
  details TEXT CHECK (details IS NULL OR json_valid(details))
);
INSERT INTO user_security_events_next (id, user_id, action, occurred_at)
SELECT id, user_id, action, occurred_at FROM user_security_events;
DROP TABLE user_security_events;
ALTER TABLE user_security_events_next RENAME TO user_security_events;
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

-- Enrolling again while two-factor authentication is on replaces the secret
-- of a verified authenticator, which takes effect at once. A first enrollment
-- is recorded when it is verified (two_factor_enabled), not here.
CREATE TRIGGER user_security_authenticator AFTER UPDATE OF secret ON twoFactor
WHEN OLD.verified = 1 AND NEW.verified = 1 AND OLD.secret IS NOT NEW.secret
BEGIN
  INSERT INTO user_security_events (user_id, action, occurred_at)
  VALUES (NEW.userId, 'two_factor_authenticator_replaced',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Signing in with a backup code also rewrites the codes, so only the write
-- Better Auth makes for /two-factor/generate-backup-codes carries this mark
-- (auth/organizationActivity.ts).
ALTER TABLE twoFactor ADD COLUMN activity_change TEXT
  CHECK (activity_change IS NULL
         OR activity_change = 'backup_codes_regenerated');

CREATE TRIGGER user_security_backup_codes
AFTER UPDATE OF backupCodes, activity_change ON twoFactor
WHEN NEW.activity_change IS NOT NULL
BEGIN
  INSERT INTO user_security_events (user_id, action, occurred_at)
  SELECT NEW.userId, 'two_factor_backup_codes_regenerated',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.activity_change = 'backup_codes_regenerated'
    AND OLD.backupCodes IS NOT NEW.backupCodes;

  UPDATE twoFactor SET activity_change = NULL WHERE id = NEW.id;
END;

-- Only the person changes their own name or picture (/update-user; the admin
-- endpoints are disabled). The picture's address is not kept.
CREATE TRIGGER user_security_name AFTER UPDATE OF name ON user
WHEN OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO user_security_events (user_id, action, occurred_at, details)
  VALUES (NEW.id, 'name_changed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          json_object('before', OLD.name, 'after', NEW.name));
END;

CREATE TRIGGER user_security_image AFTER UPDATE OF image ON user
WHEN OLD.image IS NOT NEW.image
BEGIN
  INSERT INTO user_security_events (user_id, action, occurred_at)
  VALUES (NEW.id, 'image_changed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
