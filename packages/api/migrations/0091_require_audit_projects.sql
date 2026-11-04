-- Every audit belongs to a project, enforced by a NOT NULL foreign key.
-- Projects are now deleted softly (hidden and restorable), so an audit's
-- project is never removed under it; only purging the organization deletes
-- projects outright, and their audits go with them.

ALTER TABLE projects ADD COLUMN deleted_at TEXT;
ALTER TABLE projects ADD COLUMN deleted_by_user_id TEXT
  REFERENCES user (id) ON DELETE SET NULL;

CREATE INDEX projects_organization_deleted_idx
ON projects (organization_id, deleted_at);

-- Audits started without a project cannot satisfy the constraint and are
-- removed, as agreed for this pre-release change. Their delete triggers
-- remove their issues and history; issue photos are tombstoned for storage
-- cleanup as with any other deleted issue.
DELETE FROM audits WHERE project_id IS NULL;

-- SQLite cannot add NOT NULL to an existing column, so the table is rebuilt.
-- Other tables' triggers name `audits`; the legacy rename keeps them as they
-- are rather than failing on them (supported by D1:
-- developers.cloudflare.com/d1/sql-api/sql-statements). Nothing references
-- `audits` by foreign key.
CREATE TABLE audits_next (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  template_id TEXT REFERENCES audit_templates (id) ON DELETE SET NULL,
  template_name TEXT NOT NULL,
  definition TEXT NOT NULL,
  responses TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  template_family_id TEXT
    REFERENCES audit_template_families (id) ON DELETE SET NULL,
  template_version_id TEXT
    REFERENCES audit_template_versions (id) ON DELETE SET NULL,
  template_version INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  activity_actor_id TEXT REFERENCES user (id) ON DELETE RESTRICT,
  deleted_at TEXT,
  deleted_by_user_id TEXT REFERENCES user (id) ON DELETE SET NULL
);

INSERT INTO audits_next (
  id, organization_id, project_id, template_id, template_name, definition,
  responses, status, started_by, completed_at, created_at, updated_at,
  template_family_id, template_version_id, template_version, revision,
  activity_actor_id, deleted_at, deleted_by_user_id
)
SELECT
  id, organization_id, project_id, template_id, template_name, definition,
  responses, status, started_by, completed_at, created_at, updated_at,
  template_family_id, template_version_id, template_version, revision,
  activity_actor_id, deleted_at, deleted_by_user_id
FROM audits;

PRAGMA legacy_alter_table = ON;
DROP TABLE audits;
ALTER TABLE audits_next RENAME TO audits;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX audits_organization_idx ON audits (organization_id, created_at);
CREATE INDEX audits_template_family_idx
ON audits (template_family_id, template_version);
CREATE INDEX audits_organization_deleted_created_idx
ON audits (organization_id, deleted_at, created_at DESC);
CREATE INDEX audits_project_idx ON audits (project_id);

-- The triggers on `audits` went with the old table; these are their latest
-- definitions (0049_create_activity_events.sql, 0062_create_issues.sql).
CREATE TRIGGER activity_audit_insert AFTER INSERT ON audits
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', NEW.id, NEW.template_name,
         'audit_run', NEW.id, 'audit.started', actor.id, actor.name, actor.email,
         NEW.created_at, json_object('templateVersion', NEW.template_version)
  FROM user AS actor WHERE actor.id = NEW.started_by;
END;

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
         actor.id, actor.name, actor.email, NEW.updated_at,
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

CREATE TRIGGER activity_audit_delete AFTER DELETE ON audits
BEGIN
  DELETE FROM activity_events WHERE root_type = 'audit_run' AND root_id = OLD.id;
END;

CREATE TRIGGER issues_audit_delete AFTER DELETE ON audits
BEGIN
  DELETE FROM issues WHERE organization_id = OLD.organization_id AND target_type = 'audit_run' AND target_id = OLD.id;
END;
