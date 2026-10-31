-- A contract event made through an organization API key also names the key
-- and whether MCP or the REST API called it. The actor is still the key's
-- creator. Like the shared activity's, the key's name is a snapshot; removing
-- the key row clears only the link. Earlier events are not backfilled.
ALTER TABLE contract_events ADD COLUMN api_key_id TEXT
  REFERENCES organization_api_keys (id) ON DELETE SET NULL;
ALTER TABLE contract_events ADD COLUMN api_key_name TEXT;
ALTER TABLE contract_events ADD COLUMN api_key_channel TEXT
  CHECK (api_key_channel IN ('mcp', 'rest'));

CREATE INDEX contract_events_api_key_idx ON contract_events (api_key_id);
