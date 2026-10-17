-- Promote existing audit issues without changing their IDs, attachments, or history.
CREATE TABLE issues (
  id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('audit_run', 'finance_transaction', 'workspace')),
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
      OR (target_type = 'audit_run' AND target_id IS NOT NULL AND item_id IS NOT NULL)
      OR (target_type = 'finance_transaction' AND target_id IS NOT NULL AND item_id IS NULL))
);
INSERT INTO issues
  (id, organization_id, target_type, target_id, item_id, title, description,
   priority, status, assigned_to, created_by, created_at, updated_at, revision, activity_actor_id)
SELECT id, organization_id, 'audit_run', audit_id, item_id, title, description,
       priority, status, assigned_to, created_by, created_at, updated_at, revision, activity_actor_id
FROM audit_issues;

-- Repoint attachments without triggering storage deletion or emitting new activity.
DROP TRIGGER activity_issue_image_activate;
DROP TRIGGER tombstone_cascaded_audit_issue_image;
CREATE TABLE issue_images_migration (
  id TEXT NOT NULL PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  object_id TEXT NOT NULL UNIQUE REFERENCES objects (id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES user (id) ON DELETE RESTRICT,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 10),
  created_at TEXT NOT NULL,
  UNIQUE (issue_id, slot)
);
INSERT INTO issue_images_migration SELECT * FROM audit_issue_images;
DROP TABLE audit_issue_images;
ALTER TABLE issue_images_migration RENAME TO audit_issue_images;
DROP TABLE audit_issues;
CREATE INDEX audit_issue_images_issue_idx ON audit_issue_images (issue_id, created_at);
CREATE INDEX issues_organization_idx ON issues (organization_id, created_at DESC, id DESC);
CREATE INDEX issues_target_idx ON issues (organization_id, target_type, target_id, status);
CREATE INDEX issues_assignee_idx ON issues (assigned_to);

-- Polymorphic references need explicit validation and retention behavior.
CREATE TRIGGER issue_target_insert BEFORE INSERT ON issues
WHEN (NEW.target_type = 'audit_run' AND NOT EXISTS (
  SELECT 1 FROM audits WHERE id = NEW.target_id AND organization_id = NEW.organization_id AND deleted_at IS NULL
)) OR (NEW.target_type = 'finance_transaction' AND NOT EXISTS (
  SELECT 1 FROM plaid_transactions WHERE id = NEW.target_id AND organization_id = NEW.organization_id AND source_status = 'active'
))
BEGIN
  SELECT RAISE(ABORT, 'Issue target is unavailable');
END;
CREATE TRIGGER issue_target_immutable BEFORE UPDATE OF organization_id, target_type, target_id, item_id ON issues
WHEN NEW.organization_id IS NOT OLD.organization_id OR NEW.target_type IS NOT OLD.target_type
  OR NEW.target_id IS NOT OLD.target_id OR NEW.item_id IS NOT OLD.item_id
BEGIN
  SELECT RAISE(ABORT, 'Issue target cannot be changed');
END;
CREATE TRIGGER issues_audit_delete AFTER DELETE ON audits
BEGIN
  DELETE FROM issues WHERE organization_id = OLD.organization_id AND target_type = 'audit_run' AND target_id = OLD.id;
END;
CREATE TRIGGER issues_transaction_delete AFTER DELETE ON plaid_transactions
BEGIN
  DELETE FROM issues WHERE organization_id = OLD.organization_id AND target_type = 'finance_transaction' AND target_id = OLD.id;
  DELETE FROM activity_events WHERE root_type = 'finance_transaction' AND root_id = OLD.id;
END;

CREATE TRIGGER activity_issue_insert AFTER INSERT ON issues
WHEN NEW.target_type = 'audit_run'
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', NEW.id, 'audit.issue_created', actor.id, actor.name, actor.email,
         NEW.created_at,
         json_object('title', NEW.title, 'itemId', NEW.item_id,
                     'description', NEW.description, 'priority', NEW.priority,
                     'assignedTo', NEW.assigned_to,
                     'assigneeName', assignee.name, 'assigneeEmail', assignee.email)
  FROM audits AS audit
  JOIN user AS actor ON actor.id = NEW.created_by
  LEFT JOIN user AS assignee ON assignee.id = NEW.assigned_to
  WHERE audit.id = NEW.target_id;
END;

-- Foreign-key unassignment and other maintenance do not increment revision;
-- they must never be attributed to the last person who edited an issue.
CREATE TRIGGER activity_issue_update AFTER UPDATE ON issues
WHEN NEW.target_type = 'audit_run' AND NEW.revision <> OLD.revision AND NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', NEW.id,
         CASE WHEN NEW.status = 'resolved' THEN 'audit.issue_resolved' ELSE 'audit.issue_reopened' END,
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.status, 'after', NEW.status)
  FROM audits AS audit
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  WHERE audit.id = NEW.target_id AND NEW.status <> OLD.status;

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue', NEW.id, 'audit.issue_assigned',
         actor.id, actor.name, actor.email, NEW.updated_at,
         json_object('title', NEW.title, 'before', OLD.assigned_to, 'after', NEW.assigned_to,
                     'beforeName', previous.name, 'beforeEmail', previous.email,
                     'afterName', current.name, 'afterEmail', current.email)
  FROM audits AS audit
  JOIN user AS actor ON actor.id = NEW.activity_actor_id
  LEFT JOIN user AS previous ON previous.id = OLD.assigned_to
  LEFT JOIN user AS current ON current.id = NEW.assigned_to
  WHERE audit.id = NEW.target_id AND NEW.assigned_to IS NOT OLD.assigned_to;
END;

CREATE TRIGGER activity_issue_image_activate AFTER UPDATE ON objects
WHEN NEW.kind = 'audit_issue_image' AND OLD.deletion_pending = 1 AND NEW.deletion_pending = 0
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT issue.organization_id, 'audit_run', audit.id, audit.template_name,
         'audit_issue_image', image.id, 'audit.image_uploaded', actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('filename', NEW.filename, 'issueId', issue.id, 'title', issue.title)
  FROM audit_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  JOIN audits AS audit ON audit.id = issue.target_id AND issue.target_type = 'audit_run'
  JOIN user AS actor ON actor.id = image.uploaded_by
  WHERE image.object_id = NEW.id;
END;

CREATE TRIGGER tombstone_cascaded_audit_issue_image
BEFORE DELETE ON audit_issue_images
WHEN EXISTS (
  SELECT 1
  FROM objects
  WHERE id = OLD.object_id
    AND kind = 'audit_issue_image'
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
    AND kind = 'audit_issue_image';
END;


CREATE VIEW issue_activity_roots AS
SELECT issue.id,
       CASE WHEN issue.target_type = 'workspace' THEN 'issue' ELSE issue.target_type END AS root_type,
       COALESCE(issue.target_id, issue.id) AS root_id,
       COALESCE(audit.template_name, txn.merchant_name, txn.name, issue.title) AS root_label
FROM issues AS issue
LEFT JOIN audits AS audit ON issue.target_type = 'audit_run' AND audit.id = issue.target_id
LEFT JOIN plaid_transactions AS txn ON issue.target_type = 'finance_transaction' AND txn.id = issue.target_id;

CREATE TRIGGER general_issue_insert AFTER INSERT ON issues
WHEN NEW.target_type <> 'audit_run'
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
WHEN NEW.target_type <> 'audit_run' AND NEW.revision <> OLD.revision AND NEW.status <> OLD.status
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
CREATE TRIGGER general_issue_assignee AFTER UPDATE ON issues
WHEN NEW.target_type <> 'audit_run' AND NEW.revision <> OLD.revision AND NEW.assigned_to IS NOT OLD.assigned_to
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
