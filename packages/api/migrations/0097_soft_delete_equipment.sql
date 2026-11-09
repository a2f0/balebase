-- Equipment is deleted softly: a deleted item is hidden and restorable, and
-- keeps its assignee, email links, and history. Its email links stay hidden
-- until it is restored. Only purging the organization removes the row.
ALTER TABLE equipment ADD COLUMN deleted_at TEXT;
ALTER TABLE equipment ADD COLUMN deleted_by_user_id TEXT
  REFERENCES user (id) ON DELETE SET NULL;

CREATE INDEX equipment_organization_deleted_idx
ON equipment (organization_id, deleted_at);
