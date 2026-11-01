-- Activity can record changes no person made: maintenance jobs (`system`) and
-- provider updates such as Stripe, Plaid, or Checkr (`provider`). Those events
-- name their source (the job ID or the provider) instead of a user, so no
-- human identity is ever borrowed, and keep what caused them (a job run, a
-- webhook event): one event per cause, action, root, and subject. A user event
-- still requires its user. actor_name keeps a display label for every event,
-- so readers that predate actor_type still show who acted.
--
-- SQLite cannot relax NOT NULL in place, so the table is rebuilt. The rebuild
-- keeps every column, default, index, and trigger the previous Worker writes
-- or relies on; its inserts name no new column and default to user events.
CREATE TABLE activity_events_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT REFERENCES organization (id) ON DELETE CASCADE,
  root_type TEXT NOT NULL,
  root_id TEXT NOT NULL,
  root_label TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT REFERENCES user (id) ON DELETE RESTRICT,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details)),
  historical INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0, 1)),
  actor_api_key_id TEXT REFERENCES organization_api_keys (id) ON DELETE SET NULL,
  actor_api_key_name TEXT,
  actor_api_key_channel TEXT CHECK (actor_api_key_channel IN ('mcp', 'rest')),
  actor_type TEXT NOT NULL DEFAULT 'user'
    CHECK (actor_type IN ('user', 'system', 'provider')),
  actor_source TEXT,
  causation_type TEXT,
  causation_id TEXT,
  CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL)),
  CHECK ((actor_type = 'user') = (actor_source IS NULL)),
  CHECK (actor_source IS NULL OR trim(actor_source) <> ''),
  CHECK (actor_type = 'user' OR actor_api_key_name IS NULL),
  CHECK ((causation_type IS NULL) = (causation_id IS NULL))
);

INSERT INTO activity_events_next (
  id, organization_id, root_type, root_id, root_label, subject_type,
  subject_id, action, actor_user_id, actor_name, actor_email, occurred_at,
  details, historical, actor_api_key_id, actor_api_key_name,
  actor_api_key_channel, actor_type
)
SELECT id, organization_id, root_type, root_id, root_label, subject_type,
       subject_id, action, actor_user_id, actor_name, actor_email, occurred_at,
       details, historical, actor_api_key_id, actor_api_key_name,
       actor_api_key_channel, 'user'
FROM activity_events;

-- Dozens of triggers on other tables write activity_events by name. The legacy
-- rename leaves them as written, so they resolve to the rebuilt table; the
-- modern rename would refuse while the old table is gone.
PRAGMA legacy_alter_table = ON;
DROP TABLE activity_events;
ALTER TABLE activity_events_next RENAME TO activity_events;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX activity_events_organization_idx
ON activity_events (organization_id, id DESC);
CREATE INDEX activity_events_root_idx
ON activity_events (root_type, root_id, organization_id, id DESC);
CREATE INDEX activity_events_actor_idx ON activity_events (actor_user_id);
CREATE INDEX activity_events_api_key_idx ON activity_events (actor_api_key_id);
CREATE INDEX activity_events_organization_resource_idx
ON activity_events (organization_id, root_type, id DESC);
-- The deduplication boundary for system and provider work: a redelivered job
-- run or webhook records nothing new. See systemActivityStatement.
CREATE UNIQUE INDEX activity_events_causation_idx
ON activity_events (causation_type, causation_id, action, root_type, root_id,
                    subject_type, subject_id)
WHERE causation_id IS NOT NULL;
-- Platform purge history (organization_id IS NULL) read by root admins.
CREATE INDEX activity_events_global_action_idx
ON activity_events (action, id DESC)
WHERE organization_id IS NULL;

-- Unchanged from 0061, except that only user events can name an API key.
CREATE TRIGGER activity_api_key_attribution AFTER INSERT ON activity_events
WHEN NEW.actor_type = 'user' AND EXISTS (SELECT 1 FROM activity_api_key_context)
BEGIN
  UPDATE activity_events
  SET actor_api_key_id = api_key.id,
      actor_api_key_name = api_key.name,
      actor_api_key_channel = context.channel
  FROM activity_api_key_context AS context
  JOIN organization_api_keys AS api_key ON api_key.id = context.api_key_id
  WHERE activity_events.id = NEW.id
    AND api_key.created_by = NEW.actor_user_id
    AND api_key.organization_id IS NEW.organization_id;
END;
