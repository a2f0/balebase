import {
  type Business,
  businessesRoutes,
  type DeletedBusiness,
} from "@balebase/validators/businesses";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import {
  canManage,
  requireManager,
} from "../organizations/organizationMembers";
import {
  activityBatch,
  activityStatement,
  findActivity,
  insertActivity,
} from "../shared/activity";
import { readBody, respond } from "../shared/respond";

interface BusinessRow {
  city: string | null;
  created_at: string;
  duns: string | null;
  ein: string | null;
  id: string;
  incorporation_date: string | null;
  name: string;
  state: string | null;
  street_address: string | null;
  updated_at: string;
  zip: string | null;
}

interface DeletedBusinessRow extends BusinessRow {
  deleted_at: string;
  deleter_email: string | null;
  deleter_id: string | null;
  deleter_name: string | null;
}

type BusinessContext = Context<ApiEnv>;

const invalidBusinessMessage =
  "Business details are invalid. Use a valid name, EIN, DUNS number, incorporation date, street address, city, two-letter state, and ZIP code.";

export const businesses = new Hono<ApiEnv>();

const requireBusinessManager = requireManager(
  "Organization manager access is required.",
);

businesses.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT ${businessSelect}
     FROM businesses
     WHERE organization_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<BusinessRow>();
  return respond(context, businessesRoutes.list, {
    businesses: result.results.map(businessResponse),
    canManage: canManage(context),
  });
});

businesses.get("/deleted", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT ${businessSelect}, businesses.deleted_at,
            deleter.id AS deleter_id, deleter.name AS deleter_name,
            deleter.email AS deleter_email
     FROM businesses
     LEFT JOIN user AS deleter ON deleter.id = businesses.deleted_by_user_id
     WHERE businesses.organization_id = ?
       AND businesses.deleted_at IS NOT NULL
     ORDER BY businesses.deleted_at DESC, businesses.id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<DeletedBusinessRow>();
  return respond(context, businessesRoutes.listDeleted, {
    businesses: result.results.map(deletedBusinessResponse),
    canManage: canManage(context),
  });
});

businesses.get("/:id", async (context) => {
  const business = await findBusiness(
    context.env.DB,
    context.get("organizationId"),
    context.req.param("id"),
  );
  if (!business) return context.json({ error: "Business not found." }, 404);
  return respond(context, businessesRoutes.get, {
    business: businessResponse(business),
    canManage: canManage(context),
  });
});

businesses.post("/", requireBusinessManager, async (context) => {
  const input = await readBody(
    context,
    businessesRoutes.create,
    invalidBusinessMessage,
  );
  if (input instanceof Response) return input;

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const database = context.env.DB;
  // The event reads the row this batch inserts, so a duplicate identifier,
  // which inserts nothing, records nothing.
  const [result] = await activityBatch(database, context.get("apiKey"), [
    database
      .prepare(
        `INSERT OR IGNORE INTO businesses
       (id, organization_id, name, ein, duns, incorporation_date,
        street_address, city, state, zip, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        context.get("organizationId"),
        input.name,
        input.ein ?? null,
        input.duns ?? null,
        input.incorporationDate ?? null,
        input.streetAddress ?? null,
        input.city ?? null,
        input.state ?? null,
        input.zip ?? null,
        context.get("authSession").user.id,
        timestamp,
        timestamp,
      ),
    businessEvent(context, id, "business.created", "live"),
  ]);
  if (!result?.meta.changes) {
    return (
      (await duplicateIdentifier(context, id, {
        duns: input.duns ?? null,
        ein: input.ein ?? null,
      })) ?? context.json({ error: "The business was not saved." }, 409)
    );
  }
  return respond(
    context,
    businessesRoutes.create,
    {
      business: businessResponse({
        city: input.city ?? null,
        created_at: timestamp,
        duns: input.duns ?? null,
        ein: input.ein ?? null,
        id,
        incorporation_date: input.incorporationDate ?? null,
        name: input.name,
        state: input.state ?? null,
        street_address: input.streetAddress ?? null,
        updated_at: timestamp,
        zip: input.zip ?? null,
      }),
    },
    201,
  );
});

businesses.patch("/:id", requireBusinessManager, async (context) => {
  const input = await readBody(
    context,
    businessesRoutes.update,
    invalidBusinessMessage,
  );
  if (input instanceof Response) return input;

  const id = context.req.param("id");
  const existing = await findBusiness(
    context.env.DB,
    context.get("organizationId"),
    id,
  );
  if (!existing) return context.json({ error: "Business not found." }, 404);

  // Omitted fields keep their stored values.
  const next = Object.fromEntries(
    businessFields.map(([field, column]) => [
      column,
      input[field] === undefined ? existing[column] : input[field],
    ]),
  ) as BusinessValues;
  const changes = businessChanges(existing, next);

  // A save that changes nothing writes and records nothing.
  if (!changes.length) {
    return respond(context, businessesRoutes.update, {
      business: businessResponse(existing),
    });
  }
  const timestamp = new Date().toISOString();
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  // The update applies only over the values just read, and the event, next
  // in the batch, only when that update changed the row, so a duplicate
  // identifier (ignored) or a concurrent change records nothing.
  const asRead = {
    bindings: [id, organizationId, ...businessColumns.map((c) => existing[c])],
    sql: `id = ? AND organization_id = ? AND deleted_at IS NULL
      ${businessColumns.map((column) => `AND ${column} IS ?`).join(" ")}`,
  };
  const [result] = await activityBatch(database, context.get("apiKey"), [
    database
      .prepare(
        `UPDATE OR IGNORE businesses
         SET ${businessColumns.map((column) => `${column} = ?`).join(", ")},
             updated_at = ?
         WHERE ${asRead.sql}`,
      )
      .bind(
        ...businessColumns.map((column) => next[column]),
        timestamp,
        ...asRead.bindings,
      ),
    activityStatement(
      database,
      {
        action: "business.updated",
        actorId: context.get("authSession").user.id,
        details: { changes },
        occurredAt: timestamp,
        organizationId,
        root: { id, label: next.name, type: "business" },
        subject: { id, type: "business" },
      },
      { bindings: [], sql: "changes() > 0" },
    ),
  ]);
  if (!result?.meta.changes) {
    const current = await findBusiness(database, organizationId, id);
    if (!current) return context.json({ error: "Business not found." }, 404);
    return (
      (await duplicateIdentifier(context, id, next)) ??
      context.json(
        {
          error:
            "This business changed while you were saving. Reload it and try again.",
        },
        409,
      )
    );
  }
  const updated = await findBusiness(database, organizationId, id);
  if (!updated) return context.json({ error: "Business not found." }, 404);
  return respond(context, businessesRoutes.update, {
    business: businessResponse(updated),
  });
});

// Deleting hides the business: its history stays for a restore, and it keeps
// its EIN and DUNS number, so no other business takes them meanwhile.
businesses.delete("/:id", requireBusinessManager, async (context) => {
  const id = context.req.param("id");
  const database = context.env.DB;
  // The event snapshots the business this batch hides, so a repeated or
  // racing delete records nothing.
  const [, result] = await activityBatch(database, context.get("apiKey"), [
    businessEvent(context, id, "business.deleted", "live"),
    database
      .prepare(
        `UPDATE businesses SET deleted_at = ?, deleted_by_user_id = ?
         WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      )
      .bind(
        new Date().toISOString(),
        context.get("authSession").user.id,
        id,
        context.get("organizationId"),
      ),
  ]);
  if (!result?.meta.changes) {
    return context.json({ error: "Business not found." }, 404);
  }
  return context.body(null, 204);
});

businesses.post("/:id/restore", requireBusinessManager, async (context) => {
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const [, result] = await activityBatch(database, context.get("apiKey"), [
    businessEvent(context, id, "business.restored", "deleted"),
    database
      .prepare(
        `UPDATE businesses SET deleted_at = NULL, deleted_by_user_id = NULL
         WHERE id = ? AND organization_id = ? AND deleted_at IS NOT NULL`,
      )
      .bind(id, organizationId),
  ]);
  if (!result?.meta.changes) {
    return context.json({ error: "Business not found." }, 404);
  }
  const restored = await findBusiness(database, organizationId, id);
  if (!restored) return context.json({ error: "Business not found." }, 404);
  return respond(context, businessesRoutes.restore, {
    business: businessResponse(restored),
  });
});

businesses.get("/:id/activity", async (context) => {
  const organizationId = context.get("organizationId");
  const business = await findBusiness(
    context.env.DB,
    organizationId,
    context.req.param("id"),
  );
  if (!business) return context.json({ error: "Business not found." }, 404);
  const page = await findActivity(
    context.env.DB,
    organizationId,
    context.req.query("cursor"),
    { id: business.id, type: "business" },
  );
  return page
    ? respond(context, businessesRoutes.activity, page)
    : context.json({ error: "Invalid activity cursor." }, 400);
});

type BusinessValues = Pick<
  BusinessRow,
  | "city"
  | "duns"
  | "ein"
  | "incorporation_date"
  | "name"
  | "state"
  | "street_address"
  | "zip"
>;

/** Each recorded field, and the column that stores it. */
const businessFields = [
  ["name", "name"],
  ["ein", "ein"],
  ["duns", "duns"],
  ["incorporationDate", "incorporation_date"],
  ["streetAddress", "street_address"],
  ["city", "city"],
  ["state", "state"],
  ["zip", "zip"],
] as const satisfies readonly (readonly [string, keyof BusinessValues])[];

const businessColumns = businessFields.map(([, column]) => column);

/** The columns a business response reads. */
const businessSelect = ["id", ...businessColumns, "created_at", "updated_at"]
  .map((column) => `businesses.${column}`)
  .join(", ");

/**
 * Every member can read the activity feed, so events name only the last four
 * digits of an EIN or DUNS number, never the whole identifier.
 */
function maskedIdentifier(value: string | null) {
  return value === null ? null : `•••${value.slice(-4)}`;
}

function maskedIdentifierSql(column: string) {
  return `CASE WHEN ${column} IS NULL THEN NULL
    ELSE '•••' || substr(${column}, -4) END`;
}

/** Each field a save changes, with identifiers masked. */
function businessChanges(before: BusinessValues, after: BusinessValues) {
  return businessFields.flatMap(([field, column]) =>
    after[column] === before[column]
      ? []
      : [
          {
            after: recordedValue(column, after[column]),
            before: recordedValue(column, before[column]),
            field,
          },
        ],
  );
}

function recordedValue(column: keyof BusinessValues, value: string | null) {
  return column === "ein" || column === "duns"
    ? maskedIdentifier(value)
    : value;
}

/**
 * Records a business event snapshotting the stored row, labelled with its
 * name, only while the business is in the organization and `state` (live or
 * deleted). Put it before the change it describes.
 */
function businessEvent(
  context: BusinessContext,
  id: string,
  action: string,
  state: "deleted" | "live",
) {
  return context.env.DB.prepare(
    `${insertActivity}
     SELECT business.organization_id, 'business', business.id, business.name,
            'business', business.id, ?, actor.id, actor.name, actor.email, ?,
            json_object('name', business.name,
                        'ein', ${maskedIdentifierSql("business.ein")},
                        'duns', ${maskedIdentifierSql("business.duns")},
                        'incorporationDate', business.incorporation_date,
                        'streetAddress', business.street_address,
                        'city', business.city, 'state', business.state,
                        'zip', business.zip)
     FROM businesses AS business
     JOIN user AS actor ON actor.id = ?
     WHERE business.id = ? AND business.organization_id = ?
       AND business.deleted_at IS ${state === "live" ? "" : "NOT "}NULL`,
  ).bind(
    action,
    new Date().toISOString(),
    context.get("authSession").user.id,
    id,
    context.get("organizationId"),
  );
}

/** A live business: deleted ones are found only through the deleted list. */
function findBusiness(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT ${businessSelect}
       FROM businesses
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    )
    .bind(id, organizationId)
    .first<BusinessRow>();
}

function businessResponse(row: BusinessRow): Business {
  return {
    city: row.city,
    createdAt: row.created_at,
    duns: row.duns,
    ein: row.ein,
    id: row.id,
    incorporationDate: row.incorporation_date,
    name: row.name,
    state: row.state,
    streetAddress: row.street_address,
    updatedAt: row.updated_at,
    zip: row.zip,
  };
}

function deletedBusinessResponse(row: DeletedBusinessRow): DeletedBusiness {
  return {
    ...businessResponse(row),
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

/**
 * The refusal for a write ignored because another business in the
 * organization already holds one of its identifiers, or null when none does;
 * name the DUNS number only when it alone collides. A deleted business keeps
 * its identifiers, so the refusal points to restoring it instead.
 */
async function duplicateIdentifier(
  context: BusinessContext,
  id: string,
  { duns, ein }: { duns: string | null; ein: string | null },
) {
  const holders = await context.env.DB.prepare(
    `SELECT ein, duns, deleted_at
     FROM businesses
     WHERE organization_id = ? AND id <> ? AND (ein = ? OR duns = ?)`,
  )
    .bind(context.get("organizationId"), id, ein, duns)
    .all<Pick<BusinessRow, "duns" | "ein"> & { deleted_at: string | null }>();
  const holding = (field: "duns" | "ein", value: string | null) =>
    value === null
      ? []
      : holders.results.filter((holder) => holder[field] === value);
  const einHolders = holding("ein", ein);
  const dunsHolders = holding("duns", duns);
  if (!einHolders.length && !dunsHolders.length) return null;
  const [identifier, colliding] = einHolders.length
    ? (["EIN", einHolders] as const)
    : (["DUNS number", dunsHolders] as const);
  return context.json(
    {
      error: colliding.some((holder) => holder.deleted_at === null)
        ? `A business with that ${identifier} already exists.`
        : `A deleted business has that ${identifier}. Restore it from Deleted businesses.`,
    },
    409,
  );
}
