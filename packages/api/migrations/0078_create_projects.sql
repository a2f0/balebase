-- Projects group organization members around the audit forms they use. A
-- member of a project gets its enabled forms downloaded for offline work.
CREATE TABLE projects (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Counts saved edits to the name and description; an edit must name the
  -- revision it was made from.
  revision INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX projects_organization_name_idx
ON projects (organization_id, name COLLATE NOCASE);

-- A membership counts only while the person belongs to the organization:
-- leaving it hides them from its projects without changing this record.
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  added_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_members_user_idx
ON project_members (organization_id, user_id);

-- The audit forms toggled on for a project. A form is a template family, so
-- members always receive its current version.
CREATE TABLE project_audit_forms (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL
    REFERENCES audit_template_families (id) ON DELETE CASCADE,
  added_by TEXT REFERENCES user (id) ON DELETE SET NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, template_id)
);

CREATE INDEX project_audit_forms_template_idx
ON project_audit_forms (template_id);
