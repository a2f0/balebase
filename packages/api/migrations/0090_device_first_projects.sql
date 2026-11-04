-- Device-first project audits. A device keeps the forms of its person's
-- projects and starts audits on itself; completed audits sync when it is
-- online, recorded against their project.

-- The project an audit was started for. A project deleted later leaves its
-- audits in place without one.
ALTER TABLE audits ADD COLUMN project_id TEXT
  REFERENCES projects (id) ON DELETE SET NULL;

CREATE INDEX audits_project_idx ON audits (project_id)
WHERE project_id IS NOT NULL;

-- The sync cursor of what devices keep: a counter per organization (and
-- `global` for global forms) that every change to a project, its members or
-- forms, a form's versions, or the organization's membership advances in the
-- same transaction. A device sends the counters it last read; any difference
-- means something it keeps may have changed, including removals that leave
-- no row behind. Counters, not timestamps, so clock skew and two writes in
-- one millisecond cannot hide a change. A deleted organization's row is left
-- behind; nothing reads it.
CREATE TABLE offline_sync_revisions (
  scope TEXT NOT NULL PRIMARY KEY,
  revision INTEGER NOT NULL
);

CREATE TRIGGER offline_sync_project_insert AFTER INSERT ON projects
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_update AFTER UPDATE ON projects
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_delete AFTER DELETE ON projects
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (OLD.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_member_insert
AFTER INSERT ON project_members
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_member_delete
AFTER DELETE ON project_members
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (OLD.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_form_insert
AFTER INSERT ON project_audit_forms
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_form_delete
AFTER DELETE ON project_audit_forms
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (OLD.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

-- Every save, publication, unpublication, or discard moves a family to a new
-- current version.
CREATE TRIGGER offline_sync_form_update
AFTER UPDATE OF current_version ON audit_template_families
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (COALESCE(NEW.organization_id, 'global'), 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_form_delete
AFTER DELETE ON audit_template_families
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (COALESCE(OLD.organization_id, 'global'), 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

-- Joining or leaving the organization changes whose project memberships
-- count, and the people a device can assign issues to.
CREATE TRIGGER offline_sync_member_insert AFTER INSERT ON member
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (NEW.organizationId, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_member_delete AFTER DELETE ON member
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (OLD.organizationId, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

-- A renamed person is renamed in each organization's member directory.
CREATE TRIGGER offline_sync_user_update AFTER UPDATE OF name, email ON user
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  SELECT organizationId, 1 FROM member WHERE userId = NEW.id
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;
