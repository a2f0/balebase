-- Discarded global forms can be restored until the purge job deletes them, so
-- name both changes in their history instead of "saved a form version". The
-- trigger is replaced within this migration; every earlier write still records.
DROP TRIGGER activity_template_version_insert;

CREATE TRIGGER activity_template_version_insert
AFTER INSERT ON audit_template_versions
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT family.organization_id, 'audit_template', family.id, NEW.name,
         'audit_template', family.id,
         CASE WHEN NEW.version = 1 THEN 'audit.template_created'
              WHEN NEW.status = 'discarded' THEN 'audit.template_discarded'
              WHEN EXISTS (
                SELECT 1 FROM audit_template_versions AS previous
                WHERE previous.template_id = NEW.template_id
                  AND previous.version = NEW.version - 1
                  AND previous.status = 'discarded'
              ) THEN 'audit.template_restored'
              ELSE 'audit.template_version_saved' END,
         actor.id, actor.name, actor.email, NEW.created_at,
         json_object('version', NEW.version)
  FROM audit_template_families AS family
  JOIN user AS actor ON actor.id = NEW.created_by
  WHERE family.id = NEW.template_id;
END;
