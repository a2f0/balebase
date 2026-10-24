-- A receipt and its domain writes commit together. Retain receipts even after
-- source retention deletes a run, so an old device cannot recreate it on retry.
CREATE TABLE offline_operations (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id, id)
);

CREATE TABLE offline_image_receipts (
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  image TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id, id)
);

-- Recheck assignments in the receipt's transaction if membership changed
-- between request validation and the issue insert.
CREATE TRIGGER offline_issue_assignee BEFORE INSERT ON issues
WHEN NEW.assigned_to IS NOT NULL
  AND EXISTS (SELECT 1 FROM offline_operations WHERE id = NEW.id AND organization_id = NEW.organization_id AND user_id = NEW.created_by)
  AND NOT EXISTS (SELECT 1 FROM member WHERE organizationId = NEW.organization_id AND userId = NEW.assigned_to)
BEGIN
  SELECT RAISE(ABORT, 'Offline issue assignee is no longer a member');
END;

DROP TRIGGER activity_issue_image_activate;
CREATE TRIGGER activity_issue_image_activate AFTER UPDATE ON objects
WHEN NEW.kind = 'audit_issue_image' AND OLD.deletion_pending = 1 AND NEW.deletion_pending = 0
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT issue.organization_id, root.root_type, root.root_id, root.root_label,
         'audit_issue_image', image.id, 'audit.image_uploaded', actor.id, actor.name, actor.email,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         json_object('filename', NEW.filename, 'issueId', issue.id, 'title', issue.title)
  FROM audit_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  JOIN issue_activity_roots AS root ON root.id = issue.id
  JOIN user AS actor ON actor.id = image.uploaded_by
  WHERE image.object_id = NEW.id;

  INSERT INTO offline_image_receipts (organization_id, user_id, id, issue_id, image)
  SELECT issue.organization_id, uploader.id, image.id, issue.id,
    json_object('id', image.id, 'contentType', NEW.content_type, 'filename', NEW.filename,
      'size', NEW.size, 'createdAt', image.created_at,
      'uploadedBy', json_object('id', uploader.id, 'email', uploader.email, 'name', uploader.name))
  FROM audit_issue_images AS image
  JOIN issues AS issue ON issue.id = image.issue_id
  JOIN user AS uploader ON uploader.id = image.uploaded_by
  WHERE image.object_id = NEW.id;
END;
