-- The actor travels in the same UPDATE as the change, so the trigger records
-- the actual previous values and commits the events atomically with it.
ALTER TABLE equipment ADD COLUMN activity_actor_id TEXT
  REFERENCES user (id) ON DELETE RESTRICT;

CREATE TRIGGER activity_equipment_insert AFTER INSERT ON equipment
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'equipment', NEW.id,
         NEW.make || ' ' || NEW.model, 'equipment', NEW.id,
         'equipment.created', actor.id, actor.name, actor.email,
         NEW.created_at,
         json_object('type', NEW.type, 'make', NEW.make, 'model', NEW.model,
                     'serialNumber', NEW.serial_number,
                     'purchaseDate', NEW.purchase_date,
                     'assignedTo', NEW.assigned_user_id,
                     'assigneeName', assignee.name,
                     'assigneeEmail', assignee.email)
  FROM user AS actor
  LEFT JOIN user AS assignee ON assignee.id = NEW.assigned_user_id
  WHERE actor.id = NEW.created_by;
END;

-- Member-removal unassignment and other maintenance carry no actor; they must
-- never be attributed to the last person who edited the equipment.
CREATE TRIGGER activity_equipment_update AFTER UPDATE ON equipment
WHEN NEW.activity_actor_id IS NOT NULL
BEGIN
  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'equipment', NEW.id,
         NEW.make || ' ' || NEW.model, 'equipment', NEW.id,
         'equipment.updated', actor.id, actor.name, actor.email,
         NEW.updated_at,
         json_object('changes', json((
           SELECT json_group_array(
                    json_object('field', field, 'before', before,
                                'after', after))
           FROM (
             SELECT 1 AS position, 'type' AS field, OLD.type AS before,
                    NEW.type AS after
             WHERE NEW.type IS NOT OLD.type
             UNION ALL
             SELECT 2, 'make', OLD.make, NEW.make
             WHERE NEW.make IS NOT OLD.make
             UNION ALL
             SELECT 3, 'model', OLD.model, NEW.model
             WHERE NEW.model IS NOT OLD.model
             UNION ALL
             SELECT 4, 'serialNumber', OLD.serial_number, NEW.serial_number
             WHERE NEW.serial_number IS NOT OLD.serial_number
             UNION ALL
             SELECT 5, 'purchaseDate', OLD.purchase_date, NEW.purchase_date
             WHERE NEW.purchase_date IS NOT OLD.purchase_date
             ORDER BY position
           )
         )))
  FROM user AS actor
  WHERE actor.id = NEW.activity_actor_id
    AND (NEW.type IS NOT OLD.type OR NEW.make IS NOT OLD.make
         OR NEW.model IS NOT OLD.model
         OR NEW.serial_number IS NOT OLD.serial_number
         OR NEW.purchase_date IS NOT OLD.purchase_date);

  INSERT INTO activity_events (
    organization_id, root_type, root_id, root_label, subject_type, subject_id,
    action, actor_user_id, actor_name, actor_email, occurred_at, details
  )
  SELECT NEW.organization_id, 'equipment', NEW.id,
         NEW.make || ' ' || NEW.model, 'equipment', NEW.id,
         'equipment.assigned', actor.id, actor.name, actor.email,
         NEW.updated_at,
         json_object('before', OLD.assigned_user_id,
                     'after', NEW.assigned_user_id,
                     'beforeName', previous.name,
                     'beforeEmail', previous.email,
                     'afterName', current.name, 'afterEmail', current.email)
  FROM user AS actor
  LEFT JOIN user AS previous ON previous.id = OLD.assigned_user_id
  LEFT JOIN user AS current ON current.id = NEW.assigned_user_id
  WHERE actor.id = NEW.activity_actor_id
    AND NEW.assigned_user_id IS NOT OLD.assigned_user_id;

  UPDATE equipment SET activity_actor_id = NULL WHERE id = NEW.id;
END;

-- Deleting equipment preserves its history, including the deletion the API
-- records in the same batch. The organization foreign key removes these
-- events only when the organization is purged.
