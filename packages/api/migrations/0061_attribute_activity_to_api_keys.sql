-- Activity recorded through an organization API key also names the key, and
-- whether the request came from an MCP tool or straight to the REST API. A key
-- acts as its creator, so actor_user_id still names the person. Like the
-- actor's name and email, the key's name is a snapshot; removing the key row
-- clears only the link.
ALTER TABLE activity_events ADD COLUMN actor_api_key_id TEXT
  REFERENCES organization_api_keys (id) ON DELETE SET NULL;
ALTER TABLE activity_events ADD COLUMN actor_api_key_name TEXT;
ALTER TABLE activity_events ADD COLUMN actor_api_key_channel TEXT
  CHECK (actor_api_key_channel IN ('mcp', 'rest'));

CREATE INDEX activity_events_api_key_idx ON activity_events (actor_api_key_id);

-- SQLite has no transaction-local variables, so this table stands in for one.
-- An API-key write inserts the key's single row first in its batch and deletes
-- it last, so the row never outlives that transaction. Every activity trigger,
-- and every direct insert, is attributed the same way without carrying the key
-- through each audited table. See activityBatch in src/activity.ts.
CREATE TABLE activity_api_key_context (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  api_key_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('mcp', 'rest'))
);

-- A key-made write always acts as the key's creator in the key's
-- organization. Anything else in the batch is never credited to the key.
CREATE TRIGGER activity_api_key_attribution AFTER INSERT ON activity_events
WHEN EXISTS (SELECT 1 FROM activity_api_key_context)
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
