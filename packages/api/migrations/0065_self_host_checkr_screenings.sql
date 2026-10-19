-- Screenings use Checkr's self-hosted flow: a manager requests a check with
-- the work location, the person enters their details and signs the
-- authorization in Balebase, and the API orders the report directly. Social
-- Security numbers, birth dates, and license numbers go to Checkr only.
ALTER TABLE employee_requirements ADD COLUMN checkr_work_state TEXT;
ALTER TABLE employee_requirements ADD COLUMN checkr_work_city TEXT;
ALTER TABLE employee_requirements ADD COLUMN checkr_requested_at TEXT;
ALTER TABLE employee_requirements ADD COLUMN checkr_report_status TEXT;
ALTER TABLE employee_requirements ADD COLUMN checkr_consent_id TEXT;

-- Reports already ordered through a hosted invitation keep refreshing.
UPDATE employee_requirements
SET checkr_report_status = CASE
      WHEN checkr_invitation_status IN ('canceled', 'partially_canceled')
        THEN checkr_invitation_status
      WHEN status = 'complete' THEN 'complete'
      ELSE 'pending'
    END
WHERE checkr_report_id IS NOT NULL;

-- Hosted invitations without a report cannot continue; the manager requests
-- the check again.
UPDATE employee_requirements
SET checkr_candidate_id = NULL, checkr_starting_at = NULL,
    checkr_start_nonce = NULL, checkr_start_nonce_at = NULL,
    checkr_start_package = NULL, checkr_refresh_requested_at = NULL,
    status = CASE WHEN status = 'complete' THEN status ELSE 'pending' END,
    checkr_refresh_revision = checkr_refresh_revision + 1
WHERE checkr_report_id IS NULL
  AND (checkr_invitation_id IS NOT NULL OR checkr_start_nonce IS NOT NULL);

ALTER TABLE employee_requirements DROP COLUMN checkr_invitation_id;
ALTER TABLE employee_requirements DROP COLUMN checkr_invitation_status;
ALTER TABLE employee_requirements DROP COLUMN checkr_attempt;

-- Each signed authorization, kept as a private PDF in R2 and uploaded to the
-- Checkr candidate as its consent document. A failed attempt keeps its record.
CREATE TABLE employee_screening_consents (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL
    REFERENCES employee_requirements (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  signature_name TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  disclosure_version TEXT NOT NULL,
  state_notices TEXT NOT NULL,
  copy_requested INTEGER NOT NULL DEFAULT 0,
  document_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX employee_screening_consents_requirement_idx
ON employee_screening_consents (organization_id, requirement_id, signed_at);

CREATE TRIGGER queue_screening_consent_cleanup
BEFORE DELETE ON employee_screening_consents
BEGIN
  INSERT OR REPLACE INTO deleted_object_cleanup (
    id, organization_id, object_key, deleted_at, cleanup_token,
    cleanup_claimed_at
  ) VALUES (
    'screening-consent:' || lower(hex(randomblob(16))),
    OLD.organization_id,
    OLD.document_key,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NULL,
    NULL
  );
END;
