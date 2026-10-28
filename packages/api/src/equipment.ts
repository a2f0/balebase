import {
  type EquipmentItem,
  equipmentRoutes,
} from "@balebase/validators/equipment";
import { type Context, Hono } from "hono";
import { activityBatch, findActivity } from "./activity";
import type { ApiEnv } from "./authMiddleware";
import { normalizeBusinessDate } from "./businesses";
import { listLinkedEmails, toLinkedEmail } from "./inboundEmailLinks";
import {
  canManage,
  listMemberDirectory,
  requireManager,
} from "./organizationMembers";
import { respond } from "./respond";

type EquipmentContext = Context<ApiEnv>;

/** The types offered for new equipment. Adding one needs no migration. */
const equipmentTypes = ["computer", "cell_phone", "monitor"] as const;
type EquipmentType = (typeof equipmentTypes)[number];

interface EquipmentRow {
  assigned_user_id: string | null;
  assignee_email: string | null;
  assignee_name: string | null;
  created_at: string;
  email_count: number;
  id: string;
  make: string;
  model: string;
  purchase_date: string | null;
  serial_number: string | null;
  type: string;
  updated_at: string;
}

interface EquipmentInput {
  assigneeId: string | null;
  make: string;
  model: string;
  purchaseDate: string | null;
  serialNumber: string | null;
  type: EquipmentType;
}

const equipmentSelect = `
  SELECT item.id, item.type, item.make, item.model, item.serial_number,
         item.purchase_date, item.assigned_user_id, item.created_at,
         item.updated_at, assignee.name AS assignee_name,
         assignee.email AS assignee_email,
         (SELECT COUNT(*) FROM inbound_email_links AS link
          JOIN inbound_emails AS email ON email.id = link.email_id
          WHERE link.organization_id = item.organization_id
            AND link.target_type = 'equipment' AND link.target_id = item.id
            AND email.deleted_at IS NULL) AS email_count
  FROM equipment AS item
  LEFT JOIN user AS assignee ON assignee.id = item.assigned_user_id`;

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
       WHERE item.organization_id = ?
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
  const input = equipmentInput(await context.req.json().catch(() => null));
  if (!input) return invalidEquipment(context);
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
    input.serialNumber,
    input.purchaseDate,
    input.assigneeId,
    context.get("authSession").user.id,
    now,
    now,
    input.assigneeId,
    organizationId,
    input.assigneeId,
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
  const changes = equipmentChanges(
    await context.req.json().catch(() => null),
    existing.type,
  );
  if (!changes) return invalidEquipment(context);
  const columns = Object.keys(changes) as EquipmentColumn[];
  const assigneeChanges = "assigned_user_id" in changes;
  const assigneeId = changes.assigned_user_id ?? null;
  // The actor rides along so the update trigger records who changed what.
  const update = context.env.DB.prepare(
    `UPDATE equipment
     SET ${columns.map((column) => `${column} = ?, `).join("")}updated_at = ?,
         activity_actor_id = ?
     WHERE id = ? AND organization_id = ?
       ${assigneeChanges ? `AND ${assigneeIsMember}` : ""}`,
  ).bind(
    ...columns.map((column) => changes[column] ?? null),
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

equipment.delete("/:id", requireManager(), async (context) => {
  const organizationId = context.get("organizationId");
  const item = await findEquipment(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!item) return equipmentNotFound(context);
  // Drop email links explicitly rather than relying on the trigger alone.
  // The event reads the row it describes, so it is recorded only when this
  // batch is the one that deletes it.
  await activityBatch(context.env.DB, context.get("apiKey"), [
    context.env.DB.prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_user_id, actor_name, actor_email,
         occurred_at, details
       )
       SELECT item.organization_id, 'equipment', item.id,
              item.make || ' ' || item.model, 'equipment', item.id,
              'equipment.deleted', actor.id, actor.name, actor.email, ?,
              json_object('type', item.type, 'make', item.make,
                          'model', item.model,
                          'serialNumber', item.serial_number,
                          'purchaseDate', item.purchase_date)
       FROM equipment AS item
       JOIN user AS actor ON actor.id = ?
       WHERE item.id = ? AND item.organization_id = ?`,
    ).bind(
      new Date().toISOString(),
      context.get("authSession").user.id,
      item.id,
      organizationId,
    ),
    context.env.DB.prepare(
      `DELETE FROM inbound_email_links
       WHERE organization_id = ? AND target_type = 'equipment'
         AND target_id = ?`,
    ).bind(organizationId, item.id),
    context.env.DB.prepare(
      `DELETE FROM equipment WHERE id = ? AND organization_id = ?`,
    ).bind(item.id, organizationId),
  ]);
  return context.body(null, 204);
});

function findEquipment(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `${equipmentSelect} WHERE item.id = ? AND item.organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<EquipmentRow>();
}

/** Validates a new item; optional fields may be omitted. */
function equipmentInput(body: unknown): EquipmentInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const field = (name: string) => Reflect.get(body, name);
  const type = field("type");
  const make = requiredText(field("make"), 80);
  const model = requiredText(field("model"), 120);
  const serialNumber = optionalText(field("serialNumber"), normalizeSerial);
  const purchaseDate = optionalText(
    field("purchaseDate"),
    normalizeBusinessDate,
  );
  const assigneeId = optionalText(field("assigneeId"), normalizeUserId);
  if (
    !isEquipmentType(type) ||
    !make ||
    !model ||
    serialNumber === undefined ||
    purchaseDate === undefined ||
    assigneeId === undefined
  ) {
    return null;
  }
  return { assigneeId, make, model, purchaseDate, serialNumber, type };
}

type EquipmentColumn =
  | "assigned_user_id"
  | "make"
  | "model"
  | "purchase_date"
  | "serial_number"
  | "type";

/**
 * Validates the fields present in an update, as column changes. An item keeps
 * its current type even after that type stops being offered.
 */
function equipmentChanges(
  body: unknown,
  currentType: string,
): Partial<Record<EquipmentColumn, string | null>> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const changes: Partial<Record<EquipmentColumn, string | null>> = {};
  const fields: Array<[string, EquipmentColumn, (value: unknown) => unknown]> =
    [
      [
        "type",
        "type",
        (value) =>
          isEquipmentType(value) || value === currentType ? value : undefined,
      ],
      ["make", "make", (value) => requiredText(value, 80) ?? undefined],
      ["model", "model", (value) => requiredText(value, 120) ?? undefined],
      [
        "serialNumber",
        "serial_number",
        (value) => optionalText(value, normalizeSerial),
      ],
      [
        "purchaseDate",
        "purchase_date",
        (value) => optionalText(value, normalizeBusinessDate),
      ],
      [
        "assigneeId",
        "assigned_user_id",
        (value) => optionalText(value, normalizeUserId),
      ],
    ];
  for (const [name, column, validate] of fields) {
    const value = Reflect.get(body, name);
    if (value === undefined) continue;
    const valid = validate(value);
    if (valid === undefined) return null;
    changes[column] = valid as string | null;
  }
  return changes;
}

function requiredText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * An optional text field: absent, null, or blank is null. Returns undefined
 * when the value is invalid.
 */
function optionalText(
  value: unknown,
  normalize: (value: string) => string | null,
) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return normalize(trimmed) ?? undefined;
}

function normalizeSerial(value: string) {
  return value.length <= 100 ? value : null;
}

function normalizeUserId(value: string) {
  return value.length <= 200 ? value : null;
}

function isEquipmentType(value: unknown): value is EquipmentType {
  return equipmentTypes.some((type) => type === value);
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

function invalidEquipment(context: EquipmentContext) {
  return context.json(
    {
      error:
        "Equipment details are invalid. Choose a type and enter a make, model, and, optionally, a serial number and valid purchase date.",
    },
    400,
  );
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
