-- A form copied from a global form keeps the global form it was copied from
-- and, when the client names it, the published version the copy started from,
-- so its history can name its source. Only copies set these.
ALTER TABLE audit_template_versions ADD COLUMN copied_from_template_id TEXT;
ALTER TABLE audit_template_versions ADD COLUMN copied_from_version INTEGER;

-- Publishing and unpublishing a form are recorded as such instead of as
-- ordinary saves, and a copy's creation names the global form it came from:
-- the copied version's name, or the current published name when no version
-- was given. Earlier events keep their actions. The trigger is replaced within
-- this migration; every earlier write still records.
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
              WHEN previous.status = 'discarded' THEN 'audit.template_restored'
              WHEN NEW.status = 'published'
                   AND previous.status IS NOT 'published'
                THEN 'audit.template_published'
              WHEN NEW.status = 'unpublished'
                   AND previous.status = 'published'
                THEN 'audit.template_unpublished'
              ELSE 'audit.template_version_saved' END,
         actor.id, actor.name, actor.email, NEW.created_at,
         CASE WHEN source.id IS NULL THEN json_object('version', NEW.version)
              ELSE json_object(
                'version', NEW.version,
                'copiedFrom', json_object(
                  'templateId', source.template_id,
                  'version', NEW.copied_from_version,
                  'name', source.name
                )
              ) END
  FROM audit_template_families AS family
  JOIN user AS actor ON actor.id = NEW.created_by
  LEFT JOIN audit_template_versions AS previous
    ON previous.template_id = NEW.template_id
   AND previous.version = NEW.version - 1
  LEFT JOIN audit_template_families AS source_family
    ON source_family.id = NEW.copied_from_template_id
   AND source_family.scope = 'global'
  LEFT JOIN audit_template_versions AS source
    ON source.template_id = source_family.id
   AND source.version = COALESCE(
     NEW.copied_from_version, source_family.current_version
   )
   AND source.status = 'published'
  WHERE family.id = NEW.template_id;
END;
