import {
  type DeletedEquipment,
  type EquipmentItem,
  equipmentRoutes,
} from "@balebase/validators/equipment";
import { equipmentTypes, isEquipmentType } from "@balebase/validators/rules";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { listLinkedEmails, toLinkedEmail } from "../inbox/inboundEmailLinks";
import {
  canManage,
  listMemberDirectory,
  requireManager,
} from "../organizations/organizationMembers";
import { activityBatch, findActivity } from "../shared/activity";
import { readBody, respond } from "../shared/respond";

type EquipmentContext = Context<ApiEnv>;

interface EquipmentRow {
  assigned_user_id: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  created_at: string;
  deleted_at: string | null;
  deleter_email: string | null;
  deleter_id: string | null;
  deleter_name: string | null;
  email_count: number;
  id: string;
  make: string;
  model: string;
  purchase_date: string | null;
  serial_number: string | null;
  type: string;
  updated_at: string;
}

type DeletedEquipmentRow = EquipmentRow & { deleted_at: string };

const invalidEquipment =
  "Equipment details are invalid. Choose a type and enter a make, model, and, optionally, a serial number and valid purchase date.";

/** Each field an update can change, and the column that stores it. */
const columns = {
  assigneeId: "assigned_user_id",
  make: "make",
  model: "model",
  purchaseDate: "purchase_date",
  serialNumber: "serial_number",
  type: "type",
} as const;

const equipmentSelect = `
  SELECT item.id, item.type, item.make, item.model, item.serial_number,
         item.purchase_date, item.assigned_user_id, item.created_at,
         item.updated_at, assignee.name AS assignee_name,
         assignee.email AS assignee_email,
         (SELECT COUNT(*) FROM inbound_email_links AS link
          JOIN inbound_emails AS email ON email.id = link.email_id
          WHERE link.organization_id = item.organization_id
            AND link.target_type = 'equipment' AND link.target_id = item.id
            AND email.deleted_at IS NULL) AS email_count,
         item.deleted_at, deleter.id AS deleter_id,
         deleter.name AS deleter_name, deleter.email AS deleter_email
  FROM equipment AS item
  LEFT JOIN user AS assignee ON assignee.id = item.assigned_user_id
  LEFT JOIN user AS deleter ON deleter.id = item.deleted_by_user_id`;

// The assignee must be a current member of the organization, checked in the
// same statement as the write so a concurrent removal cannot slip past it.
const assigneeIsMember = `(? IS NULL OR EXISTS (
  SELECT 1 FROM member WHERE organizationId = ? AND userId = ?
))`;

const equipment = new Hono<ApiEnv>();

equipment.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const [items, members] = await Promise.all([
    context.env.DB.prepare(
      `${equipmentSelect}
       WHERE item.organization_id = ? AND item.deleted_at IS NULL
       ORDER BY item.created_at DESC, item.id DESC`,
    )
      .bind(organizationId)
      .all<EquipmentRow>(),
    listMemberDirectory(context.env.DB, organizationId),
  ]);
  return respond(context, equipmentRoutes.list, {
    canManage: canManage(context),
    equipment: items.results.map(toEquipment),
    members,
    types: [...equipmentTypes],
  });
});

equipment.post("/", requireManager(), async (context) => {
  const input = await readBody(
    context,
    equipmentRoutes.create,
    invalidEquipment,
  );
  if (input instanceof Response) return input;
  const assigneeId = input.assigneeId ?? null;
  const organizationId = context.get("organizationId");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const insert = context.env.DB.prepare(
    `INSERT INTO equipment
       (id, organization_id, type, make, model, serial_number, purchase_date,
        assigned_user_id, created_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${assigneeIsMember}`,
  ).bind(
    id,
    organizationId,
    input.type,
    input.make,
    input.model,
    input.serialNumber ?? null,
    input.purchaseDate ?? null,
    assigneeId,
    context.get("authSession").user.id,
    now,
    now,
    assigneeId,
    organizationId,
    assigneeId,
  );
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    insert,
  ]);
  if (result?.meta.changes === 0) return assigneeNotMember(context);
  const created = await findEquipment(context.env.DB, organizationId, id);
  if (!created) return equipmentNotFound(context);
  return respond(
    context,
    equipmentRoutes.create,
    { equipment: toEquipment(created) },
    201,
  );
});

equipment.get("/deleted", async (context) => {
  const items = await context.env.DB.prepare(
    `${equipmentSelect}
     WHERE item.organization_id = ? AND item.deleted_at IS NOT NULL
     ORDER BY item.deleted_at DESC, item.id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<DeletedEquipmentRow>();
  return respond(context, equipmentRoutes.listDeleted, {
    canManage: canManage(context),
    equipment: items.results.map(toDeletedEquipment),
  });
});

equipment.get("/:id", async (context) => {
  const organizationId = context.get("organizationId");
  const item = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!item) return equipmentNotFound(context);
  const [emails, members] = await Promise.all([
    listLinkedEmails(context.env.DB, organizationId, "equipment", item.id),
    listMemberDirectory(context.env.DB, organizationId),
  ]);
  return respond(context, equipmentRoutes.get, {
    canManage: canManage(context),
    emails: emails.map(toLinkedEmail),
    equipment: toEquipment(item),
    members,
    types: [...equipmentTypes],
  });
});

equipment.get("/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const item = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!item) return equipmentNotFound(context);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    { id: item.id, type: "equipment" },
  );
  return page
    ? respond(context, equipmentRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

// Updates only the fields present in the body, so concurrent edits to other
// fields are kept; `assigneeId: null` unassigns.
equipment.patch("/:id", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const existing = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!existing) return equipmentNotFound(context);
  const input = await readBody(
    context,
    equipmentRoutes.update,
    invalidEquipment,
  );
  if (input instanceof Response) return input;
  // An item keeps its current type even after that type stops being offered.
  if (
    input.type !== undefined &&
    input.type !== existing.type &&
    !isEquipmentType(input.type)
  )
    return context.json({ error: invalidEquipment }, 400);
  const changes = Object.entries(columns).flatMap(([field, column]) => {
    const value = input[field as keyof typeof columns];
    return value === undefined ? [] : [{ column, value }];
  });
  const assigneeChanges = input.assigneeId !== undefined;
  const assigneeId = input.assigneeId ?? null;
  // The actor rides along so the update trigger records who changed what.
  const update = context.env.DB.prepare(
    `UPDATE equipment
     SET ${changes.map(({ column }) => `${column} = ?, `).join("")}updated_at = ?,
         activity_actor_id = ?
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
       ${assigneeChanges ? `AND ${assigneeIsMember}` : ""}`,
  ).bind(
    ...changes.map(({ value }) => value),
    new Date().toISOString(),
    context.get("authSession").user.id,
    existing.id,
    organizationId,
    ...(assigneeChanges ? [assigneeId, organizationId, assigneeId] : []),
  );
  const [result] = await activityBatch(context.env.DB, context.get("apiKey"), [
    update,
  ]);
  const updated = await findEquipment(
    context.env.DB,
    organizationId,
    existing.id,
  );
  if (!updated) return equipmentNotFound(context);
  if (result?.meta.changes === 0) return assigneeNotMember(context);
  return respond(context, equipmentRoutes.update, {
    equipment: toEquipment(updated),
  });
});

// Deleting hides the item: its assignee, email links, and history stay for a
// restore, and its links are hidden until then.
equipment.delete("/:id", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const item = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!item) return equipmentNotFound(context);
  const userId = context.get("authSession").user.id;
  await activityBatch(context.env.DB, context.get("apiKey"), [
    snapshotEvent(context, "equipment.deleted", item.id),
    context.env.DB.prepare(
      `UPDATE equipment SET deleted_at = ?, deleted_by_user_id = ?
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    ).bind(new Date().toISOString(), userId, item.id, organizationId),
  ]);
  return context.body(null, 204);
});

equipment.post("/:id/restore", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const id = context.req.param("id");
  const [, restored] = await activityBatch(
    context.env.DB,
    context.get("apiKey"),
    [
      snapshotEvent(context, "equipment.restored", id),
      context.env.DB.prepare(
        `UPDATE equipment SET deleted_at = NULL, deleted_by_user_id = NULL
         WHERE id = ? AND organization_id = ? AND deleted_at IS NOT NULL`,
      ).bind(id, organizationId),
    ],
  );
  if (!restored?.meta.changes) return equipmentNotFound(context);
  const item = await findEquipment(context.env.DB, organizationId, id);
  if (!item) return equipmentNotFound(context);
  return respond(context, equipmentRoutes.restore, {
    equipment: toEquipment(item),
  });
});

/**
 * Records a deletion or restore with a snapshot of the item, including who
 * held it. Put it before the change: it reads the item in the same batch,
 * and only while the item is still in the state the change moves it out of,
 * so a repeated or racing request records nothing.
 */
function snapshotEvent(
  context: EquipmentContext,
  action: "equipment.deleted" | "equipment.restored",
  id: string,
) {
  const state =
    action === "equipment.deleted"
      ? "item.deleted_at IS NULL"
      : "item.deleted_at IS NOT NULL";
  return context.env.DB.prepare(
    `INSERT INTO activity_events (
       organization_id, root_type, root_id, root_label, subject_type,
       subject_id, action, actor_user_id, actor_name, actor_email,
       occurred_at, details
     )
     SELECT item.organization_id, 'equipment', item.id,
            item.make || ' ' || item.model, 'equipment', item.id, ?,
            actor.id, actor.name, actor.email, ?,
            json_object('type', item.type, 'make', item.make,
                        'model', item.model,
                        'serialNumber', item.serial_number,
                        'purchaseDate', item.purchase_date,
                        'assignedTo', item.assigned_user_id,
                        'assigneeName', assignee.name,
                        'assigneeEmail', assignee.email)
     FROM equipment AS item
     JOIN user AS actor ON actor.id = ?
     LEFT JOIN user AS assignee ON assignee.id = item.assigned_user_id
     WHERE item.id = ? AND item.organization_id = ? AND ${state}`,
  ).bind(
    action,
    new Date().toISOString(),
    context.get("authSession").user.id,
    id,
    context.get("organizationId"),
  );
}

/** A live item: deleted items are found only through the deleted list. */
function findEquipment(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `${equipmentSelect}
       WHERE item.id = ? AND item.organization_id = ?
         AND item.deleted_at IS NULL`,
    )
    .bind(id, organizationId)
    .first<EquipmentRow>();
}

function toEquipment(row: EquipmentRow): EquipmentItem {
  return {
    assignee: row.assigned_user_id
      ? {
          email: row.assignee_email ?? "",
          id: row.assigned_user_id,
          name: row.assignee_name ?? "",
        }
      : null,
    createdAt: row.created_at,
    emailCount: row.email_count,
    id: row.id,
    make: row.make,
    model: row.model,
    purchaseDate: row.purchase_date,
    serialNumber: row.serial_number,
    type: row.type,
    updatedAt: row.updated_at,
  };
}

function toDeletedEquipment(row: DeletedEquipmentRow): DeletedEquipment {
  return {
    ...toEquipment(row),
    deletedAt: row.deleted_at,
    deletedBy: row.deleter_id
      ? {
          email: row.deleter_email ?? "",
          id: row.deleter_id,
          name: row.deleter_name ?? "",
        }
      : null,
  };
}

function assigneeNotMember(context: EquipmentContext) {
  return context.json(
    { error: "Equipment can only be assigned to organization members." },
    400,
  );
}

function equipmentNotFound(context: EquipmentContext) {
  return context.json({ error: "Equipment not found." }, 404);
}

export { equipment };
