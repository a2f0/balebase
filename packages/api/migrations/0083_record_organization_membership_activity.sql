-- Invitations, joining by invitation, and organization renames record who did
-- them. As in 0057, the request's actor travels in the same write as the
-- change, so each trigger commits its event atomically with it. Member removal
-- and organization deletion and restoration record their events in the API's
-- own batches (memberRemoval.ts and organizationDeletion.ts).
ALTER TABLE invitation ADD COLUMN activity_actor_id TEXT
  REFERENCES user (id) ON DELETE RESTRICT;
ALTER TABLE organization ADD COLUMN activity_actor_id TEXT
  REFERENCES user (id) ON DELETE RESTRICT;
-- The invitation an accepted member joined through. It stays on the member as
-- provenance; members added any other way leave it empty.
ALTER TABLE member ADD COLUMN activity_invitation_id TEXT
  REFERENCES invitation (id) ON DELETE SET NULL;

CREATE TRIGGER activity_invitation_insert AFTER INSERT ON invitation
WHEN NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organizationId, 'organization_invitation', NEW.id, NEW.email,
         'organization_invitation', NEW.id, 'organization.invitation_created',
         actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('email', NEW.email, 'role', NEW.role,
                     'expiresAt', NEW.expiresAt)
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id;

  UPDATE invitation SET activity_actor_id = NULL WHERE id = NEW.id;
END;

-- Acceptance is recorded when the membership is created (below). Better Auth
-- returns a failed acceptance to pending; neither transition is a cancel or a
-- rejection, so neither records anything here.
CREATE TRIGGER activity_invitation_status
AFTER UPDATE OF status, activity_actor_id ON invitation
WHEN NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organizationId, 'organization_invitation', NEW.id, NEW.email,
         'organization_invitation', NEW.id,
         CASE NEW.status WHEN 'canceled' THEN 'organization.invitation_canceled'
                         ELSE 'organization.invitation_rejected' END,
         actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('email', NEW.email, 'role', NEW.role,
                     'before', OLD.status, 'after', NEW.status)
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id
    AND NEW.status IS NOT OLD.status
    AND NEW.status IN ('canceled', 'rejected');

  UPDATE invitation SET activity_actor_id = NULL WHERE id = NEW.id;
END;

-- The accepting person is the actor; the inviter is kept in the details, so a
-- role granted by an invitation names both. Everyone in the organization sees
-- the new member; only managers see the invitation's own history.
CREATE TRIGGER activity_member_invitation_insert AFTER INSERT ON member
WHEN NEW.activity_invitation_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organizationId, 'organization_member', NEW.id, joined.name,
         'organization_member', NEW.id, 'organization.member_joined',
         joined.id, joined.name, joined.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('role', NEW.role, 'userId', joined.id,
                     'userName', joined.name, 'userEmail', joined.email,
                     'invitedRole', invitation.role,
                     'inviterId', inviter.id, 'inviterName', inviter.name,
                     'inviterEmail', inviter.email)
  FROM invitation
  JOIN user AS joined ON joined.id = NEW.userId
  LEFT JOIN user AS inviter ON inviter.id = invitation.inviterId
  WHERE invitation.id = NEW.activity_invitation_id
    AND invitation.organizationId = NEW.organizationId;

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organizationId, 'organization_invitation', invitation.id,
         invitation.email, 'organization_invitation', invitation.id,
         'organization.invitation_accepted',
         joined.id, joined.name, joined.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('email', invitation.email, 'role', invitation.role,
                     'memberId', NEW.id, 'userId', joined.id)
  FROM invitation
  JOIN user AS joined ON joined.id = NEW.userId
  WHERE invitation.id = NEW.activity_invitation_id
    AND invitation.organizationId = NEW.organizationId;
END;

-- Metadata is not recorded: nothing in the app reads it, and it is free-form.
CREATE TRIGGER activity_organization_update
AFTER UPDATE OF name, slug, logo, activity_actor_id ON organization
WHEN NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.id, 'organization', NEW.id, NEW.name, 'organization', NEW.id,
         'organization.updated', actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('changes', json((
           SELECT json_group_array(
                    json_object('field', field, 'before', before,
                                'after', after))
           FROM (
             SELECT 1 AS position, 'name' AS field, OLD.name AS before,
                    NEW.name AS after
             WHERE NEW.name IS NOT OLD.name
             UNION ALL
             SELECT 2, 'slug', OLD.slug, NEW.slug
             WHERE NEW.slug IS NOT OLD.slug
             UNION ALL
             SELECT 3, 'logo', OLD.logo, NEW.logo
             WHERE NEW.logo IS NOT OLD.logo
             ORDER BY position
           )
         )))
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id
    AND (NEW.name IS NOT OLD.name OR NEW.slug IS NOT OLD.slug
         OR NEW.logo IS NOT OLD.logo);

  UPDATE organization SET activity_actor_id = NULL WHERE id = NEW.id;
END;
