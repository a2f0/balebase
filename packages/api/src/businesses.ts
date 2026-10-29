import {
  type Business,
  businessesRoutes,
} from "@balebase/validators/businesses";
import { type Context, Hono } from "hono";
import type { ApiEnv } from "./authMiddleware";
import { canManage, requireManager } from "./organizationMembers";
import { readBody, respond } from "./respond";

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

type BusinessContext = Context<ApiEnv>;

const invalidBusinessMessage =
  "Business details are invalid. Use a valid name, EIN, DUNS number, incorporation date, street address, city, two-letter state, and ZIP code.";

export const businesses = new Hono<ApiEnv>();

const requireBusinessManager = requireManager(
  "Organization manager access is required.",
);

businesses.get("/", async (context) => {
  const result = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
     FROM businesses
     WHERE organization_id = ?
     ORDER BY created_at DESC, id DESC`,
  )
    .bind(context.get("organizationId"))
    .all<BusinessRow>();
  return respond(context, businessesRoutes.list, {
    businesses: result.results.map(businessResponse),
    canManage: canManage(context),
  });
});

businesses.get("/:id", async (context) => {
  const business = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .first<BusinessRow>();
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
  const result = await context.env.DB.prepare(
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
    )
    .run();
  if (!result.meta.changes) {
    return duplicateIdentifier(context, id, {
      duns: input.duns ?? null,
      ein: input.ein ?? null,
    });
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
  const existing = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(id, context.get("organizationId"))
    .first<BusinessRow>();
  if (!existing) return context.json({ error: "Business not found." }, 404);

  const timestamp = new Date().toISOString();
  const city = input.city === undefined ? existing.city : input.city;
  const duns = input.duns === undefined ? existing.duns : input.duns;
  const ein = input.ein === undefined ? existing.ein : input.ein;
  const incorporationDate =
    input.incorporationDate === undefined
      ? existing.incorporation_date
      : input.incorporationDate;
  const streetAddress =
    input.streetAddress === undefined
      ? existing.street_address
      : input.streetAddress;
  const state = input.state === undefined ? existing.state : input.state;
  const zip = input.zip === undefined ? existing.zip : input.zip;
  const result = await context.env.DB.prepare(
    `UPDATE OR IGNORE businesses
     SET name = ?, ein = ?, duns = ?, incorporation_date = ?,
         street_address = ?, city = ?, state = ?, zip = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      input.name,
      ein,
      duns,
      incorporationDate,
      streetAddress,
      city,
      state,
      zip,
      timestamp,
      id,
      context.get("organizationId"),
    )
    .run();
  if (!result.meta.changes) {
    return duplicateIdentifier(context, id, { duns, ein });
  }
  const updated = await context.env.DB.prepare(
    `SELECT id, name, ein, duns, incorporation_date, street_address, city,
            state, zip, created_at, updated_at
     FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(id, context.get("organizationId"))
    .first<BusinessRow>();
  if (!updated) return context.json({ error: "Business not found." }, 404);
  return respond(context, businessesRoutes.update, {
    business: businessResponse(updated),
  });
});

businesses.delete("/:id", requireBusinessManager, async (context) => {
  const result = await context.env.DB.prepare(
    `DELETE FROM businesses
     WHERE id = ? AND organization_id = ?`,
  )
    .bind(context.req.param("id"), context.get("organizationId"))
    .run();
  if (!result.meta.changes) {
    return context.json({ error: "Business not found." }, 404);
  }
  return context.body(null, 204);
});

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

/**
 * A write was ignored because another business in the organization already
 * holds one of its identifiers; name the DUNS number only when it alone
 * collides.
 */
async function duplicateIdentifier(
  context: BusinessContext,
  id: string,
  { duns, ein }: { duns: string | null; ein: string | null },
) {
  const holders = await context.env.DB.prepare(
    `SELECT ein, duns
     FROM businesses
     WHERE organization_id = ? AND id <> ? AND (ein = ? OR duns = ?)`,
  )
    .bind(context.get("organizationId"), id, ein, duns)
    .all<Pick<BusinessRow, "duns" | "ein">>();
  const held = (field: "duns" | "ein", value: string | null) =>
    value !== null && holders.results.some((holder) => holder[field] === value);
  const identifier =
    held("duns", duns) && !held("ein", ein) ? "DUNS number" : "EIN";
  return context.json(
    { error: `A business with that ${identifier} already exists.` },
    409,
  );
}
