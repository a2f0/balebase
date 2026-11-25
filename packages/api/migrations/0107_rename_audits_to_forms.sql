-- Audits are now forms: the section is Forms, its definitions are form
-- templates, and each filled-in copy is a form. This renames the tables, the
-- stored type and action names that carry "audit", and the built-in template
-- library's actor. Activity-log ("audit trail") names are unchanged.
--
-- Accepted deploy window: migrations run before the new Worker is published,
-- so until it is live the previous Worker's form routes fail on the renamed
-- tables. The owner, the only user, chose a one-release rename.
--
-- Rows are kept throughout. `issues` and `objects` are rebuilt because their
-- CHECK constraints name the old values. Dropping a table with foreign keys
-- on deletes its rows first, cascading to children, so issue images are moved
-- to an unconstrained table before either parent is dropped and are restored
-- after.

-- Triggers and the view that name the old tables or values; recreated below.
DROP VIEW issue_activity_roots;
DROP TRIGGER activity_audit_delete;
DROP TRIGGER activity_audit_insert;
DROP TRIGGER activity_audit_update;
DROP TRIGGER activity_issue_image_activate;
DROP TRIGGER activity_issue_insert;
DROP TRIGGER activity_issue_update;
DROP TRIGGER activity_template_delete;
DROP TRIGGER activity_template_version_insert;
DROP TRIGGER clear_completed_library_upload;
DROP TRIGGER general_issue_assignee;
DROP TRIGGER general_issue_insert;
DROP TRIGGER general_issue_status;
DROP TRIGGER issue_details_update;
DROP TRIGGER issue_target_immutable;
DROP TRIGGER issue_target_insert;
DROP TRIGGER issues_audit_delete;
DROP TRIGGER offline_issue_assignee;
DROP TRIGGER offline_sync_form_delete;
DROP TRIGGER offline_sync_form_update;
DROP TRIGGER offline_sync_project_form_delete;
DROP TRIGGER offline_sync_project_form_insert;
DROP TRIGGER tombstone_cascaded_audit_issue_image;

-- The built-in library's actor, under its new ID, before rows move to it.
INSERT INTO "user" (
  id, name, email, emailVerified, image, createdAt, updatedAt, role, banned,
  banReason, banExpires, defaultOrganizationId, twoFactorEnabled,
  termsAccepted, termsAcceptedAt, termsVersion, defaultOrganizationPinned,
  lastActiveAt, financeOpensUncategorized, financeOpensByPayee,
  financeOpensPeriod
)
SELECT
  'system:template-library', 'Balebase template library',
  replace(email, 'audit-library', 'template-library'), emailVerified, image,
  createdAt, updatedAt, role, banned,
  'Reserved application actor for built-in form templates.', banExpires,
  defaultOrganizationId, twoFactorEnabled, termsAccepted, termsAcceptedAt,
  termsVersion, defaultOrganizationPinned, lastActiveAt,
  financeOpensUncategorized, financeOpensByPayee, financeOpensPeriod
FROM "user"
WHERE id = 'system:audit-library';

-- Renames that keep every row; references from other tables follow.
ALTER TABLE audit_templates RENAME TO legacy_form_templates;
ALTER TABLE audit_template_families RENAME TO form_template_families;
ALTER TABLE audit_template_versions RENAME TO form_template_versions;
ALTER TABLE project_audit_forms RENAME TO project_form_templates;
ALTER TABLE audits RENAME TO forms;

UPDATE form_template_families SET created_by = 'system:template-library'
WHERE created_by = 'system:audit-library';
UPDATE form_template_versions SET created_by = 'system:template-library'
WHERE created_by = 'system:audit-library';
UPDATE activity_events
SET actor_user_id = 'system:template-library',
    actor_name = 'Balebase template library'
WHERE actor_user_id = 'system:audit-library';
-- Any reference left behind refuses this delete and rolls the migration back.
DELETE FROM "user" WHERE id = 'system:audit-library';

-- Issue images wait here while their parents are rebuilt.
CREATE TABLE form_issue_images_parked AS SELECT * FROM audit_issue_images;
DROP TABLE audit_issue_images;

CREATE TABLE issues_next (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('form_run', 'finance_transaction', 'workspace')),
  target_id TEXT,
  item_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assigned_to TEXT REFERENCES user (id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  activity_actor_id TEXT REFERENCES user (id) ON DELETE RESTRICT,
  CHECK ((target_type = 'workspace' AND target_id IS NULL AND item_id IS NULL)
      OR (target_type = 'form_run' AND target_id IS NOT NULL AND item_id IS NOT NULL)
      OR (target_type = 'finance_transaction' AND target_id IS NOT NULL AND item_id IS NULL))
);
INSERT INTO issues_next (id, organization_id, target_type, target_id, item_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at, revision, activity_actor_id)
SELECT id, organization_id, CASE target_type WHEN 'audit_run' THEN 'form_run' ELSE target_type END, target_id, item_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at, revision, activity_actor_id
FROM issues;
CREATE TABLE objects_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL
, kind TEXT NOT NULL DEFAULT 'library'
CHECK (kind IN ('library', 'form_issue_image')), deletion_pending INTEGER NOT NULL DEFAULT 0
CHECK (deletion_pending IN (0, 1)), cleanup_token TEXT, cleanup_claimed_at TEXT, upload_token TEXT, upload_lease_expires_at TEXT, folder_id TEXT
  REFERENCES library_folders (id) ON DELETE SET NULL);
INSERT INTO objects_next (id, organization_id, object_key, filename, content_type, size, created_at, kind, deletion_pending, cleanup_token, cleanup_claimed_at, upload_token, upload_lease_expires_at, folder_id)
SELECT id, organization_id, object_key, filename, content_type, size, created_at, CASE kind WHEN 'audit_issue_image' THEN 'form_issue_image' ELSE kind END, deletion_pending, cleanup_token, cleanup_claimed_at, upload_token, upload_lease_expires_at, folder_id
FROM objects;

-- Nothing references either table now, so dropping them deletes no other rows:
-- form_issue_images is their only foreign-key child, and its rows are parked
-- above. A child added before this runs would lose its rows to the implicit
-- DELETE that DROP TABLE performs, so park it the same way.
-- The legacy rename leaves other schema text naming `issues` and `objects`
-- as it is, which is the name the rebuilt tables take.
PRAGMA legacy_alter_table = ON;
DROP TABLE issues;
ALTER TABLE issues_next RENAME TO issues;
DROP TABLE objects;
ALTER TABLE objects_next RENAME TO objects;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX issues_assignee_idx ON issues (assigned_to);
CREATE INDEX issues_organization_idx ON issues (organization_id, created_at DESC, id DESC);
CREATE INDEX issues_target_idx ON issues (organization_id, target_type, target_id, status);
CREATE INDEX objects_folder_idx ON objects (folder_id);
CREATE INDEX objects_organization_created_at_idx
ON objects (organization_id, created_at DESC);
CREATE INDEX objects_organization_folder_created_at_idx
ON objects (organization_id, kind, folder_id, created_at DESC);
CREATE INDEX objects_organization_kind_created_at_idx
ON objects (organization_id, kind, created_at DESC);
CREATE INDEX objects_pending_cleanup_idx
ON objects (kind, deletion_pending, cleanup_claimed_at, created_at);
CREATE INDEX objects_pending_upload_cleanup_idx
ON objects (
  kind,
  deletion_pending,
  upload_lease_expires_at,
  cleanup_claimed_at,
  created_at
);

CREATE TABLE form_issue_images (
  id TEXT NOT NULL PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  object_id TEXT NOT NULL UNIQUE REFERENCES objects (id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 10),
  created_at TEXT NOT NULL,
  UNIQUE (issue_id, slot)
);
INSERT INTO form_issue_images (id, issue_id, object_id, uploaded_by, slot, created_at)
SELECT id, issue_id, object_id, uploaded_by, slot, created_at
FROM form_issue_images_parked;
DROP TABLE form_issue_images_parked;
CREATE INDEX form_issue_images_issue_idx ON form_issue_images (issue_id);

-- Index names follow their tables.
DROP INDEX audit_template_families_scope_idx;
CREATE INDEX form_template_families_scope_idx
ON form_template_families (scope, organization_id, updated_at DESC);
DROP INDEX audit_template_versions_template_idx;
CREATE INDEX form_template_versions_template_idx
ON form_template_versions (template_id, version DESC);
DROP INDEX audit_templates_organization_idx;
CREATE INDEX legacy_form_templates_organization_idx
ON legacy_form_templates (organization_id, updated_at);
DROP INDEX audits_organization_deleted_created_idx;
CREATE INDEX forms_organization_deleted_created_idx
ON forms (organization_id, deleted_at, created_at DESC);
DROP INDEX audits_organization_idx;
CREATE INDEX forms_organization_idx ON forms (organization_id, created_at);
DROP INDEX audits_project_idx;
CREATE INDEX forms_project_idx ON forms (project_id);
DROP INDEX audits_template_family_idx;
CREATE INDEX forms_template_family_idx
ON forms (template_family_id, template_version);
DROP INDEX project_audit_forms_template_idx;
CREATE INDEX project_form_templates_template_idx
ON project_form_templates (template_id);

-- Stored type and action names.
UPDATE activity_events SET root_type = 'form_run' WHERE root_type = 'audit_run';
UPDATE activity_events SET root_type = 'form_template'
WHERE root_type = 'audit_template';
UPDATE activity_events
SET subject_type = CASE subject_type
  WHEN 'audit_run' THEN 'form_run'
  WHEN 'audit_template' THEN 'form_template'
  WHEN 'audit_issue' THEN 'form_issue'
  WHEN 'audit_answer' THEN 'form_answer'
  WHEN 'audit_issue_image' THEN 'form_issue_image'
END
WHERE subject_type IN (
  'audit_run', 'audit_template', 'audit_issue', 'audit_answer',
  'audit_issue_image'
);
UPDATE activity_events SET action = 'form.' || substr(action, 7)
WHERE action LIKE 'audit.%';
UPDATE activity_events
SET action = CASE action
  WHEN 'project.form_enabled' THEN 'project.template_enabled'
  WHEN 'project.form_disabled' THEN 'project.template_disabled'
  WHEN 'organization.audit_runs_purged' THEN 'organization.form_runs_purged'
END
WHERE action IN (
  'project.form_enabled', 'project.form_disabled',
  'organization.audit_runs_purged'
);
UPDATE activity_events
SET details = json_set(details, '$.reason', 'template_purged')
WHERE json_extract(details, '$.reason') = 'form_purged';
UPDATE activity_events
SET actor_source = CASE actor_source
  WHEN 'purgeExpiredFreeAuditRuns' THEN 'purgeExpiredFreeFormRuns'
  WHEN 'purgeDiscardedAuditForms' THEN 'purgeDiscardedFormTemplates'
  WHEN 'purgePendingAuditIssueImages' THEN 'purgePendingFormIssueImages'
END
WHERE actor_source IN (
  'purgeExpiredFreeAuditRuns', 'purgeDiscardedAuditForms',
  'purgePendingAuditIssueImages'
);
UPDATE job_runs
SET job_id = CASE job_id
  WHEN 'purgeExpiredFreeAuditRuns' THEN 'purgeExpiredFreeFormRuns'
  WHEN 'purgeDiscardedAuditForms' THEN 'purgeDiscardedFormTemplates'
  WHEN 'purgePendingAuditIssueImages' THEN 'purgePendingFormIssueImages'
END
WHERE job_id IN (
  'purgeExpiredFreeAuditRuns', 'purgeDiscardedAuditForms',
  'purgePendingAuditIssueImages'
);

CREATE VIEW issue_activity_roots AS
SELECT issue.id,
       CASE WHEN issue.target_type = 'workspace' THEN 'issue' ELSE issue.target_type END AS root_type,
       COALESCE(issue.target_id, issue.id) AS root_id,
       COALESCE(form.template_name, txn.merchant_name, txn.name, issue.title) AS root_label
FROM issues AS issue
LEFT JOIN forms AS form ON issue.target_type = 'form_run' AND form.id = issue.target_id
LEFT JOIN plaid_transactions AS txn ON issue.target_type = 'finance_transaction' AND txn.id = issue.target_id;

CREATE TRIGGER activity_form_delete AFTER DELETE ON forms
BEGIN
  DELETE FROM activity_events WHERE root_type = 'form_run' AND root_id = OLD.id;
END;

CREATE TRIGGER activity_form_insert AFTER INSERT ON forms
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'form_run', NEW.id, NEW.template_name,
         'form_run', NEW.id, 'form.started', actor.id, actor.name, actor.email,
         NEW.created_at, json_object('templateVersion', NEW.template_version)
  FROM user AS actor WHERE actor.id = NEW.started_by;
END;

CREATE TRIGGER activity_form_update AFTER UPDATE ON forms
WHEN NEW.revision <> OLD.revision AND NEW.activity_actor_id IS NOT NULL
  AND (NEW.responses <> OLD.responses OR NEW.status <> OLD.status)
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'form_run', NEW.id, NEW.template_name,
         'form_answer', item.value ->> '$.id', 'form.answer_changed',
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
  SELECT NEW.organization_id, 'form_run', NEW.id, NEW.template_name,
         'form_run', NEW.id,
         CASE WHEN NEW.status = 'completed' THEN 'form.completed' ELSE 'form.reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('before', OLD.status, 'after', NEW.status)
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id AND NEW.status <> OLD.status;
END;

CREATE TRIGGER activity_issue_image_activate AFTER UPDATE ON objects
WHEN NEW.kind = 'form_issue_image' AND OLD.deletion_pending = 1 AND NEW.deletion_pending = 0
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT issue.organization_id, root.root_type, root.root_id, root.root_label,
         'form_issue_image', image.id, 'form.image_uploaded', actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('filename', NEW.filename, 'issueId', issue.id, 'title', issue.title)
  FROM form_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  JOIN issue_activity_roots AS root ON root.id = issue.id
  JOIN user AS actor ON actor.id = image.uploaded_by
  WHERE image.object_id = NEW.id;

  INSERT INTO offline_image_receipts (organization_id, user_id, id, issue_id, image)
  SELECT issue.organization_id, uploader.id, image.id, issue.id,
    json_object('id', image.id, 'contentType', NEW.content_type, 'filename', NEW.filename,
      'size', NEW.size, 'createdAt', image.created_at,
      'uploadedBy', json_object('id', uploader.id, 'email', uploader.email, 'name', uploader.name))
  FROM form_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  JOIN user AS uploader ON uploader.id = image.uploaded_by
  WHERE image.object_id = NEW.id;
END;

CREATE TRIGGER activity_issue_insert AFTER INSERT ON issues
WHEN NEW.target_type = 'form_run'
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'form_run', form.id, form.template_name,
         'form_issue', NEW.id, 'form.issue_created', actor.id, actor.name, actor.email,
         NEW.created_at,
         json_object('title', NEW.title, 'itemId', NEW.item_id,
                     'description', NEW.description, 'priority', NEW.priority,
                     'assignedTo', NEW.assigned_to,
                     'assigneeName', assignee.name, 'assigneeEmail', assignee.email)
  FROM forms AS form
  JOIN user AS actor ON actor.id = NEW.created_by
  LEFT JOIN user AS assignee ON assignee.id = NEW.assigned_to
  WHERE form.id = NEW.target_id;
END;

CREATE TRIGGER activity_issue_update AFTER UPDATE ON issues
WHEN NEW.target_type = 'form_run' AND NEW.revision <> OLD.revision AND NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'form_run', form.id, form.template_name,
         'form_issue', NEW.id,
         CASE WHEN NEW.status = 'resolved' THEN 'form.issue_resolved' ELSE 'form.issue_reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.status, 'after', NEW.status)
  FROM forms AS form
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE form.id = NEW.target_id AND NEW.status <> OLD.status;

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'form_run', form.id, form.template_name,
         'form_issue', NEW.id, 'form.issue_assigned',
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.assigned_to, 'after', NEW.assigned_to,
                     'beforeName', previous.name, 'beforeEmail', previous.email,
                     'afterName', current.name, 'afterEmail', current.email)
  FROM forms AS form
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  LEFT JOIN user AS previous ON previous.id = OLD.assigned_to
  LEFT JOIN user AS current ON current.id = NEW.assigned_to
  WHERE form.id = NEW.target_id AND NEW.assigned_to IS NOT OLD.assigned_to;
END;

CREATE TRIGGER activity_template_delete AFTER DELETE ON form_template_families
BEGIN
  DELETE FROM activity_events WHERE root_type = 'form_template' AND root_id = OLD.id;
END;

CREATE TRIGGER activity_template_version_insert
AFTER INSERT ON form_template_versions
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT family.organization_id, 'form_template', family.id, NEW.name,
         'form_template', family.id,
         CASE WHEN NEW.version = 1 THEN 'form.template_created'
              WHEN NEW.status = 'discarded' THEN 'form.template_discarded'
              WHEN previous.status = 'discarded' THEN 'form.template_restored'
              WHEN NEW.status = 'published'
                   AND previous.status IS NOT 'published'
                THEN 'form.template_published'
              WHEN NEW.status = 'unpublished'
                   AND previous.status = 'published'
                THEN 'form.template_unpublished'
              ELSE 'form.template_version_saved' END,
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
  FROM form_template_families AS family
  JOIN user AS actor ON actor.id = NEW.created_by
  LEFT JOIN form_template_versions AS previous
    ON previous.template_id = NEW.template_id
   AND previous.version = NEW.version - 1
  LEFT JOIN form_template_families AS source_family
    ON source_family.id = NEW.copied_from_template_id
   AND source_family.scope = 'global'
  LEFT JOIN form_template_versions AS source
    ON source.template_id = source_family.id
   AND source.version = COALESCE(
     NEW.copied_from_version, source_family.current_version
   )
   AND source.status = 'published'
  WHERE family.id = NEW.template_id;
END;

CREATE TRIGGER clear_completed_library_upload
AFTER INSERT ON objects
WHEN NEW.kind = 'library'
BEGIN
  DELETE FROM deleted_object_cleanup WHERE object_key = NEW.object_key;
END;

CREATE TRIGGER general_issue_assignee AFTER UPDATE ON issues
WHEN NEW.target_type <> 'form_run' AND NEW.revision <> OLD.revision AND NEW.assigned_to IS NOT OLD.assigned_to
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, root.root_type, root.root_id, root.root_label, 'issue', NEW.id,
         'issue.assigned', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.assigned_to, 'after', NEW.assigned_to,
                     'beforeName', previous.name, 'beforeEmail', previous.email,
                     'afterName', current.name, 'afterEmail', current.email)
  FROM issue_activity_roots AS root JOIN user AS actor ON actor.id = NEW.activity_actor_id
  LEFT JOIN user AS previous ON previous.id = OLD.assigned_to
  LEFT JOIN user AS current ON current.id = NEW.assigned_to
  WHERE root.id = NEW.id;
END;

CREATE TRIGGER general_issue_insert AFTER INSERT ON issues
WHEN NEW.target_type <> 'form_run'
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, root.root_type, root.root_id, root.root_label,
         'issue', NEW.id, 'issue.created', actor.id, actor.name, actor.email, NEW.created_at,
         json_object('title', NEW.title, 'description', NEW.description, 'priority', NEW.priority,
                     'assignedTo', NEW.assigned_to, 'assigneeName', assignee.name, 'assigneeEmail', assignee.email)
  FROM issue_activity_roots AS root
  JOIN user AS actor ON actor.id = NEW.created_by
  LEFT JOIN user AS assignee ON assignee.id = NEW.assigned_to
  WHERE root.id = NEW.id;
END;

CREATE TRIGGER general_issue_status AFTER UPDATE ON issues
WHEN NEW.target_type <> 'form_run' AND NEW.revision <> OLD.revision AND NEW.status <> OLD.status
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, root.root_type, root.root_id, root.root_label, 'issue', NEW.id,
         CASE WHEN NEW.status = 'resolved' THEN 'issue.resolved' ELSE 'issue.reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.status, 'after', NEW.status)
  FROM issue_activity_roots AS root JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE root.id = NEW.id;
END;

CREATE TRIGGER issue_details_update AFTER UPDATE ON issues
WHEN NEW.revision <> OLD.revision AND
  (NEW.title <> OLD.title OR NEW.description <> OLD.description OR NEW.priority <> OLD.priority)
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, root.root_type, root.root_id, root.root_label, 'issue', NEW.id,
         'issue.updated', actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title,
                     'before', json_object('title', OLD.title, 'description', OLD.description, 'priority', OLD.priority),
                     'after', json_object('title', NEW.title, 'description', NEW.description, 'priority', NEW.priority))
  FROM issue_activity_roots AS root JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE root.id = NEW.id;
END;

CREATE TRIGGER issue_target_immutable BEFORE UPDATE OF organization_id, target_type, target_id, item_id ON issues
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.target_type IS NOT OLD.target_type
  OR NEW.target_id IS NOT OLD.target_id OR NEW.item_id IS NOT OLD.item_id
BEGIN
  SELECT RAISE(ABORT, 'Issue target cannot be changed');
END;

CREATE TRIGGER issue_target_insert BEFORE INSERT ON issues
WHEN (NEW.target_type = 'form_run' AND NOT EXISTS (
  SELECT 1 FROM forms WHERE id = NEW.target_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
)) OR (NEW.target_type = 'finance_transaction' AND NOT EXISTS (
  SELECT 1 FROM plaid_transactions WHERE id = NEW.target_id AND organization_id = NEW.organization_id AND source_status = 'active'
))
BEGIN
  SELECT RAISE(ABORT, 'Issue target is unavailable');
END;

CREATE TRIGGER issues_form_delete AFTER DELETE ON forms
BEGIN
  DELETE FROM issues WHERE organization_id = OLD.organization_id AND target_type = 'form_run' AND target_id = OLD.id;
END;

CREATE TRIGGER offline_issue_assignee BEFORE INSERT ON issues
WHEN NEW.assigned_to IS NOT NULL
  AND EXISTS (SELECT 1 FROM offline_operations WHERE id = NEW.id AND organization_id = NEW.organization_id AND user_id = NEW.created_by)
  AND NOT EXISTS (SELECT 1 FROM member WHERE organizationId = NEW.organization_id AND userId = NEW.assigned_to)
BEGIN
  SELECT RAISE(ABORT, 'Offline issue assignee is no longer a member');
END;

CREATE TRIGGER offline_sync_template_delete
AFTER DELETE ON form_template_families
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (COALESCE(OLD.organization_id, 'global'), 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_template_update
AFTER UPDATE OF current_version ON form_template_families
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (COALESCE(NEW.organization_id, 'global'), 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_template_delete
AFTER DELETE ON project_form_templates
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (OLD.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER offline_sync_project_template_insert
AFTER INSERT ON project_form_templates
BEGIN
  INSERT INTO offline_sync_revisions (scope, revision)
  VALUES (NEW.organization_id, 1)
  ON CONFLICT (scope) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER tombstone_cascaded_form_issue_image
BEFORE DELETE ON form_issue_images
WHEN EXISTS (
  SELECT 1
  FROM objects
  WHERE id = OLD.object_id
    AND kind = 'form_issue_image'
    AND deletion_pending = 0
)
BEGIN
  UPDATE objects
  SET deletion_pending = 1,
      cleanup_token = NULL,
      cleanup_claimed_at = NULL,
      upload_token = NULL,
      upload_lease_expires_at = NULL
  WHERE id = OLD.object_id
    AND kind = 'form_issue_image';
END;
