-- Each answer's time and author, by item ID ({"at": ..., "by": ...}), so a
-- device's answers merge with the server's last writer wins by the time each
-- was given: the device's UTC clock for answers given there, the server's for
-- answers saved online.
ALTER TABLE audits ADD COLUMN answer_meta TEXT NOT NULL DEFAULT '{}';

-- The latest definition from 0091_require_audit_projects.sql, except that an
-- answer's history takes the answer's own time when it has one.
DROP TRIGGER activity_audit_update;
CREATE TRIGGER activity_audit_update AFTER UPDATE ON audits
WHEN NEW.revision <> OLD.revision AND NEW.activity_actor_id IS NOT NULL
  AND (NEW.responses <> OLD.responses OR NEW.status <> OLD.status)
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', NEW.id, NEW.template_name,
         'audit_answer', item.value ->> '$.id', 'audit.answer_changed',
         actor.id, actor.name, actor.email,
         COALESCE(answered.at, NEW.updated_at),
         json_object('prompt', item.value ->> '$.prompt',
                     'responseType', item.value ->> '$.responseType',
                     'before', previous.value, 'after', current.value)
  FROM json_each(NEW.definition, '$.sections') AS section
  JOIN json_each(section.value, '$.items') AS item
  LEFT JOIN (
    SELECT key, MAX(value) AS value FROM json_each(OLD.responses) GROUP BY key
  ) AS previous ON previous.key = item.value ->> '$.id'
  LEFT JOIN (
    SELECT key, MAX(value) AS value FROM json_each(NEW.responses) GROUP BY key
  ) AS current ON current.key = item.value ->> '$.id'
  LEFT JOIN (
    SELECT key, MAX(value ->> '$.at') AS at
    FROM json_each(NEW.answer_meta) GROUP BY key
  ) AS answered ON answered.key = item.value ->> '$.id'
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE NEW.responses <> OLD.responses AND previous.value IS NOT current.value;

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', NEW.id, NEW.template_name,
         'audit_run', NEW.id,
         CASE WHEN NEW.status = 'completed' THEN 'audit.completed' ELSE 'audit.reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', OLD.status, 'after', NEW.status)
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id AND NEW.status <> OLD.status;
END;
