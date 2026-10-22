-- Queue only newly completed reports; deploying must not email old results.
CREATE TABLE employee_screening_notifications (
  requirement_id TEXT NOT NULL REFERENCES employee_requirements (id) ON DELETE CASCADE,
  report_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  claim_token TEXT,
  sent_at TEXT,
  PRIMARY KEY (requirement_id, report_id)
);

CREATE INDEX employee_screening_notifications_pending_idx
ON employee_screening_notifications (next_attempt_at) WHERE sent_at IS NULL;

CREATE TRIGGER queue_screening_completion
AFTER UPDATE OF checkr_report_id, checkr_report_status, status ON employee_requirements
WHEN NEW.checkr_report_id IS NOT NULL
  AND NEW.checkr_report_status = 'complete' AND NEW.status = 'complete'
  AND (OLD.checkr_report_id IS NOT NEW.checkr_report_id
    OR OLD.checkr_report_status IS NOT 'complete' OR OLD.status <> 'complete')
BEGIN
  INSERT OR IGNORE INTO employee_screening_notifications
    (requirement_id, report_id, user_id, created_at, next_attempt_at)
  SELECT NEW.id, NEW.checkr_report_id, member.userId, NEW.updated_at, NEW.updated_at
  FROM member
  WHERE member.id = NEW.member_id AND member.organizationId = NEW.organization_id;
END;
