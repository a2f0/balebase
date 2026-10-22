-- Match workspace resource filters and their newest-first cursor pagination.
CREATE INDEX activity_events_organization_resource_idx
ON activity_events (organization_id, root_type, id DESC);
