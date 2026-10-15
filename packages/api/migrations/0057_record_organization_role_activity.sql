ALTER TABLE member ADD COLUMN activity_actor_id TEXT
  REFERENCES user (id) ON DELETE RESTRICT;

-- The actor travels in the same UPDATE as the role. A trigger captures the
-- actual previous role and commits the event atomically with the change.
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
                     'userEmail', affected.email)
  FROM user AS actor
  JOIN user AS affected ON affected.id = NEW.userId
  WHERE actor.id = NEW.activity_actor_id AND NEW.role <> OLD.role;

  -- Do not attribute a later maintenance update to this request's actor.
  UPDATE member SET activity_actor_id = NULL WHERE id = NEW.id;
END;

-- Membership removal must preserve role history. The existing organization
-- foreign key removes these events only when the organization is purged.
