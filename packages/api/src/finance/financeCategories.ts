import {
  type ExpenseCategory,
  financeRoutes,
} from "@balebase/validators/finance";
import { financeLimits } from "@balebase/validators/rules";
import { activityBatch, requestActor } from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import type { FinanceContext } from "./financeContext";

interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  transaction_count: number;
}

const invalidName = `Category names need 1 to ${financeLimits.categoryName} characters.`;

/** Client routes use this slug for expenses without a category. */
const uncategorizedSlug = "uncategorized";

/** Offered in one click to organizations that have no categories yet. */
const defaultExpenseCategories = [
  "Advertising and marketing",
  "Bank and processing fees",
  "Charitable contributions",
  "Contractors",
  "Equipment",
  "Insurance",
  "Meals",
  "Office supplies",
  "Payroll",
  "Personal",
  "Professional services",
  "Rent and utilities",
  "Software and subscriptions",
  "Taxes and licenses",
  "Travel",
  "Vehicle and fuel",
] as const;

export async function listExpenseCategories(
  database: D1Database,
  organizationId: string,
) {
  const result = await database
    .prepare(
      `SELECT category.id, category.name, category.slug,
              COUNT(txn.id) AS transaction_count
       FROM finance_expense_categories AS category
       LEFT JOIN finance_transaction_annotations AS annotation
         ON annotation.expense_category_id = category.id
       LEFT JOIN plaid_transactions AS txn
         ON txn.id = annotation.transaction_id
        AND txn.source_status = 'active'
       WHERE category.organization_id = ?
       GROUP BY category.id
       ORDER BY category.name COLLATE NOCASE ASC`,
    )
    .bind(organizationId)
    .all<CategoryRow>();
  return result.results.map(toCategory);
}

export async function listCategories(context: FinanceContext) {
  return respond(context, financeRoutes.listCategories, {
    categories: await listExpenseCategories(
      context.env.DB,
      context.get("organizationId"),
    ),
  });
}

export async function createCategory(context: FinanceContext) {
  const input = await readBody(
    context,
    financeRoutes.createCategory,
    invalidName,
  );
  if (input instanceof Response) return input;
  const { name } = input;
  const organizationId = context.get("organizationId");
  if (await nameTaken(context.env.DB, organizationId, name)) {
    return duplicateName(context);
  }
  const database = context.env.DB;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const actor = requestActor(context);
  const slug = await writeWithSlug(
    database,
    organizationId,
    name,
    null,
    (slug) =>
      activityBatch(database, actor.apiKey, [
        database
          .prepare(
            `INSERT INTO finance_expense_categories
             (id, organization_id, name, slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, organizationId, name, slug, now, now),
        categoryEvent(database, {
          action: "finance.category_created",
          actorId: actor.userId,
          details: "json_object('name', category.name, 'slug', category.slug)",
          id,
          occurredAt: now,
          organizationId,
        }),
      ]),
  );
  return respond(
    context,
    financeRoutes.createCategory,
    { category: { id, name, slug, transactionCount: 0 } },
    201,
  );
}

export async function renameCategory(context: FinanceContext) {
  const id = context.req.param("id");
  const input = await readBody(
    context,
    financeRoutes.renameCategory,
    invalidName,
  );
  if (input instanceof Response) return input;
  const { name } = input;
  const organizationId = context.get("organizationId");
  if (!id || !(await findCategory(context.env.DB, organizationId, id))) {
    return categoryNotFound(context);
  }
  if (await nameTaken(context.env.DB, organizationId, name, id)) {
    return duplicateName(context);
  }
  // The slug follows the name, so a renamed category's old link stops working.
  const database = context.env.DB;
  const actor = requestActor(context);
  const slug = await writeWithSlug(
    database,
    organizationId,
    name,
    id,
    (slug) => {
      const now = new Date().toISOString();
      // Saving the current name and slug changes nothing and records nothing.
      const changed = (table: string) => ({
        bindings: [name, slug],
        sql: `(${table}.name <> ? OR ${table}.slug <> ?)`,
      });
      return activityBatch(database, actor.apiKey, [
        categoryEvent(database, {
          action: "finance.category_renamed",
          actorId: actor.userId,
          details: `json_object('beforeName', category.name, 'afterName', ?,
          'beforeSlug', category.slug, 'afterSlug', ?)`,
          detailBindings: [name, slug],
          id,
          label: name,
          occurredAt: now,
          organizationId,
          when: changed("category"),
        }),
        database
          .prepare(
            `UPDATE finance_expense_categories
           SET name = ?, slug = ?, updated_at = ?
           WHERE id = ? AND organization_id = ?
             AND ${changed("finance_expense_categories").sql}`,
          )
          .bind(name, slug, now, id, organizationId, name, slug),
      ]);
    },
  );
  return respond(context, financeRoutes.renameCategory, {
    category: { id, name, slug },
  });
}

export async function deleteCategory(context: FinanceContext) {
  const id = context.req.param("id");
  const organizationId = context.get("organizationId");
  if (!id || !(await findCategory(context.env.DB, organizationId, id))) {
    return categoryNotFound(context);
  }
  const database = context.env.DB;
  const actor = requestActor(context);
  const now = new Date().toISOString();
  // Unassign explicitly rather than relying on the foreign-key action alone,
  // so each transaction's activity names who removed its category.
  const results = await activityBatch(database, actor.apiKey, [
    categoryEvent(database, {
      action: "finance.category_deleted",
      actorId: actor.userId,
      details: `json_object('name', category.name, 'slug', category.slug,
        'transactionCount', (SELECT COUNT(*) FROM finance_transaction_annotations
          WHERE organization_id = category.organization_id
            AND expense_category_id = category.id))`,
      id,
      occurredAt: now,
      organizationId,
    }),
    database
      .prepare(
        `UPDATE finance_transaction_annotations
         SET expense_category_id = NULL, updated_by = ?, updated_at = ?
         WHERE organization_id = ? AND expense_category_id = ?`,
      )
      .bind(actor.userId, now, organizationId, id),
    database
      .prepare(
        `DELETE FROM finance_expense_categories
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(id, organizationId),
  ]);
  // A concurrent delete removed it first and recorded the deletion.
  if (!results.at(-1)?.meta.changes) return categoryNotFound(context);
  return context.body(null, 204);
}

export async function addDefaultCategories(context: FinanceContext) {
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  // OR IGNORE skips a default whose name or slug a concurrent write took; the
  // next pass adds it under a free slug unless its name now exists.
  for (let pass = 1; pass <= 3; pass++) {
    const inserts = await missingDefaultInserts(database, organizationId);
    if (!inserts.length) break;
    await activityBatch(database, actor.apiKey, [
      ...inserts.map(({ statement }) => statement),
      defaultsAddedEvent(
        database,
        actor.userId,
        organizationId,
        inserts.map(({ id }) => id),
      ),
    ]);
  }
  return respond(context, financeRoutes.addDefaultCategories, {
    categories: await listExpenseCategories(database, organizationId),
  });
}

async function missingDefaultInserts(
  database: D1Database,
  organizationId: string,
) {
  const existing = await database
    .prepare(
      `SELECT lower(name) AS name, slug FROM finance_expense_categories
       WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .all<{ name: string; slug: string }>();
  const names = new Set(existing.results.map(({ name }) => name));
  const slugs = new Set(existing.results.map(({ slug }) => slug));
  const now = new Date().toISOString();
  return defaultExpenseCategories
    .filter((name) => !names.has(name.toLowerCase()))
    .map((name) => {
      const slug = uniqueSlug(name, slugs);
      slugs.add(slug);
      const id = crypto.randomUUID();
      const statement = database
        .prepare(
          `INSERT OR IGNORE INTO finance_expense_categories
             (id, organization_id, name, slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, organizationId, name, slug, now, now);
      return { id, statement };
    });
}

/**
 * One event naming the defaults this batch inserted. Their IDs are new, so
 * the rows that exist when it runs are exactly those its inserts added; when
 * a concurrent write took them all, nothing is recorded.
 */
function defaultsAddedEvent(
  database: D1Database,
  actorId: string,
  organizationId: string,
  ids: string[],
) {
  const inserted = `FROM finance_expense_categories
    WHERE organization_id = ? AND id IN (${ids.map(() => "?").join(", ")})`;
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_user_id, actor_name, actor_email,
         occurred_at, details
       )
       SELECT ?, 'finance_category', ?, 'Expense categories',
              'finance_category', ?, 'finance.categories_defaults_added',
              actor.id, actor.name, actor.email, ?,
              json_object('names', json((SELECT json_group_array(name)
                FROM (SELECT name ${inserted} ORDER BY name))))
       FROM user AS actor
       WHERE actor.id = ? AND EXISTS (SELECT 1 ${inserted})`,
    )
    .bind(
      organizationId,
      organizationId,
      organizationId,
      new Date().toISOString(),
      organizationId,
      ...ids,
      actorId,
      organizationId,
      ...ids,
    );
}

/**
 * An event for one stored category, labelled and detailed from its row as the
 * batch reads it. Nothing is recorded when the category, or `when`, no longer
 * matches.
 */
function categoryEvent(
  database: D1Database,
  input: {
    action: string;
    actorId: string;
    detailBindings?: string[];
    /** A JSON expression over the `category` row. */
    details: string;
    id: string;
    label?: string;
    occurredAt: string;
    organizationId: string;
    when?: { bindings: string[]; sql: string };
  },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_user_id, actor_name, actor_email,
         occurred_at, details
       )
       SELECT category.organization_id, 'finance_category', category.id,
              COALESCE(?, category.name), 'finance_category', category.id, ?,
              actor.id, actor.name, actor.email, ?, ${input.details}
       FROM finance_expense_categories AS category
       JOIN user AS actor ON actor.id = ?
       WHERE category.id = ? AND category.organization_id = ?
         AND ${input.when?.sql ?? "1"}`,
    )
    .bind(
      input.label ?? null,
      input.action,
      input.occurredAt,
      ...(input.detailBindings ?? []),
      input.actorId,
      input.id,
      input.organizationId,
      ...(input.when?.bindings ?? []),
    );
}

/** Sets or clears a transaction's single expense category. */
export async function assignTransactionCategory(context: FinanceContext) {
  const transactionId = context.req.param("id") ?? "";
  const input = await readBody(
    context,
    financeRoutes.setTransactionCategory,
    "A category or null is required.",
  );
  if (input instanceof Response) return input;
  const { categoryId } = input;
  const organizationId = context.get("organizationId");
  const database = context.env.DB;
  const transaction = await database
    .prepare(
      `SELECT id FROM plaid_transactions WHERE id = ? AND organization_id = ?`,
    )
    .bind(transactionId, organizationId)
    .first<{ id: string }>();
  if (!transaction) {
    return context.json({ error: "Transaction not found." }, 404);
  }
  if (
    categoryId &&
    !(await findCategory(database, organizationId, categoryId))
  ) {
    return categoryNotFound(context);
  }
  const now = new Date().toISOString();
  const userId = context.get("authSession").user.id;
  const statement = database
    .prepare(
      `INSERT INTO finance_transaction_annotations
         (transaction_id, organization_id, note, labels, reviewed,
          expense_category_id, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, '', '[]', 0, ?, ?, ?, ?, ?)
       ON CONFLICT(transaction_id) DO UPDATE SET
         expense_category_id = excluded.expense_category_id,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .bind(transactionId, organizationId, categoryId, userId, userId, now, now);
  await activityBatch(database, context.get("apiKey"), [statement]);
  return respond(context, financeRoutes.setTransactionCategory, {
    expenseCategoryId: categoryId,
  });
}

async function findCategory(
  database: D1Database,
  organizationId: string,
  id: string,
) {
  return database
    .prepare(
      `SELECT id FROM finance_expense_categories
       WHERE id = ? AND organization_id = ?`,
    )
    .bind(id, organizationId)
    .first<{ id: string }>();
}

async function nameTaken(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId?: string,
) {
  const existing = await database
    .prepare(
      `SELECT id FROM finance_expense_categories
       WHERE organization_id = ? AND name = ? COLLATE NOCASE`,
    )
    .bind(organizationId, name)
    .first<{ id: string }>();
  return Boolean(existing && existing.id !== exceptId);
}

/**
 * Lowercase ASCII letters and digits joined by single hyphens, with accents
 * dropped, as migration 0065 slugged existing names.
 */
function categorySlug(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "category";
}

/** The name's slug, numbered past slugs that are reserved or already used. */
function uniqueSlug(name: string, taken: Set<string>) {
  const base = categorySlug(name);
  let slug = base;
  for (
    let number = 2;
    slug === uncategorizedSlug || taken.has(slug);
    number++
  ) {
    slug = `${base}-${number}`;
  }
  return slug;
}

/**
 * Writes a category with the name's next free slug, choosing again when a
 * concurrent write takes that slug first.
 */
async function writeWithSlug(
  database: D1Database,
  organizationId: string,
  name: string,
  exceptId: string | null,
  write: (slug: string) => Promise<unknown>,
) {
  for (let attempt = 1; ; attempt++) {
    const taken = await database
      .prepare(
        `SELECT slug FROM finance_expense_categories
         WHERE organization_id = ? AND id IS NOT ?`,
      )
      .bind(organizationId, exceptId)
      .all<{ slug: string }>();
    const slug = uniqueSlug(
      name,
      new Set(taken.results.map((row) => row.slug)),
    );
    try {
      await write(slug);
      return slug;
    } catch (error) {
      const slugTaken =
        error instanceof Error &&
        error.message.includes("finance_expense_categories.slug");
      if (!slugTaken || attempt === 3) throw error;
    }
  }
}

function toCategory(row: CategoryRow): ExpenseCategory {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    transactionCount: row.transaction_count,
  };
}

function duplicateName(context: FinanceContext) {
  return context.json({ error: "A category with that name exists." }, 409);
}

function categoryNotFound(context: FinanceContext) {
  return context.json({ error: "Category not found." }, 404);
}
