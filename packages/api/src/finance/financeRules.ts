import {
  type CategorizationRule,
  financeRoutes,
} from "@balebase/validators/finance";
import { financeLimits } from "@balebase/validators/rules";
import { Hono } from "hono";
import type { ApiEnv } from "../auth/apiEnv";
import { activityBatch, requestActor } from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import {
  type ActivityCausation,
  categorizationRuleActor,
  systemActivityRowsStatement,
} from "../shared/systemActivity";
import type { FinanceContext } from "./financeContext";

/**
 * Categorization rules: a payee's transactions (those shown under exactly
 * the rule's payee name) get the rule's expense category. Rules fill only
 * transactions without a category, never replacing one someone chose: on
 * import, as Balebase's work, and on request, as the requester's.
 */
export const categorizationRules = new Hono<ApiEnv>();

categorizationRules.get("/", listRules);
categorizationRules.post("/", createRule);
categorizationRules.post("/:id/apply", applyRule);
categorizationRules.delete("/:id", deleteRule);

interface RuleRow {
  category_id: string;
  category_name: string;
  created_at: string;
  id: string;
  payee_name: string;
  uncategorized_count: number;
}

/** The name a transaction is shown under, as rules and the name filter match it. */
const payee = "COALESCE(txn.merchant_name, txn.name)";

/**
 * A payee's active transactions without a category, for the `rule` in scope:
 * the rows applying it fills.
 */
const uncategorized = `FROM plaid_transactions AS txn
  LEFT JOIN finance_transaction_annotations AS annotation
    ON annotation.transaction_id = txn.id
  WHERE txn.organization_id = rule.organization_id
    AND txn.source_status = 'active'
    AND ${payee} = rule.payee_name
    AND annotation.expense_category_id IS NULL`;

function readRules(database: D1Database, organizationId: string, id?: string) {
  return database
    .prepare(
      `SELECT rule.id, rule.payee_name, rule.created_at,
              category.id AS category_id, category.name AS category_name,
              (SELECT COUNT(*) ${uncategorized}) AS uncategorized_count
       FROM finance_categorization_rules AS rule
       JOIN finance_expense_categories AS category
         ON category.id = rule.expense_category_id
       WHERE rule.organization_id = ? AND (? IS NULL OR rule.id = ?)
       ORDER BY rule.payee_name`,
    )
    .bind(organizationId, id ?? null, id ?? null)
    .all<RuleRow>();
}

async function listRules(context: FinanceContext) {
  const rules = await readRules(context.env.DB, context.get("organizationId"));
  return respond(context, financeRoutes.listCategorizationRules, {
    rules: rules.results.map(toRule),
  });
}

async function createRule(context: FinanceContext) {
  const input = await readBody(
    context,
    financeRoutes.createCategorizationRule,
    "A payee name, a category, and applyToExisting are required.",
  );
  if (input instanceof Response) return input;
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // The category and the rule limit are rechecked in the insert, and the
  // events read the inserted rule, so nothing is recorded when it is refused.
  const statements = [
    database
      .prepare(
        `INSERT OR IGNORE INTO finance_categorization_rules
           (id, organization_id, payee_name, expense_category_id, created_at)
         SELECT ?, category.organization_id, ?, category.id, ?
         FROM finance_expense_categories AS category
         WHERE category.id = ? AND category.organization_id = ?
           AND (SELECT COUNT(*) FROM finance_categorization_rules
                WHERE organization_id = ?) < ?`,
      )
      .bind(
        id,
        input.payeeName,
        now,
        input.categoryId,
        organizationId,
        organizationId,
        financeLimits.categorizationRules,
      ),
    ruleEvent(database, actor.userId, now, id, {
      action: "finance.categorization_rule_created",
      details: `json_object('payeeName', rule.payee_name,
        'categoryId', category.id, 'categoryName', category.name)`,
      organizationId,
    }),
    ...(input.applyToExisting
      ? applyStatements(database, actor.userId, now, id, organizationId)
      : []),
  ];
  const results = await activityBatch(database, actor.apiKey, statements);
  if (!results[0]?.meta.changes) return refusedRule(context, input);
  const applied = input.applyToExisting ? appliedCount(results) : 0;
  const rule = (await readRules(database, organizationId, id)).results[0];
  if (!rule) return ruleNotFound(context);
  return respond(
    context,
    financeRoutes.createCategorizationRule,
    { applied, rule: toRule(rule) },
    201,
  );
}

/** Why an insert of `input` added no rule: a taken payee, a gone category, or the limit. */
async function refusedRule(
  context: FinanceContext,
  input: { categoryId: string; payeeName: string },
) {
  const organizationId = context.get("organizationId");
  const state = await context.env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM finance_categorization_rules
               WHERE organization_id = ?1 AND payee_name = ?2) AS taken,
       EXISTS (SELECT 1 FROM finance_expense_categories
               WHERE organization_id = ?1 AND id = ?3) AS category`,
  )
    .bind(organizationId, input.payeeName, input.categoryId)
    .first<{ category: number; taken: number }>();
  if (state?.taken) {
    return context.json({ error: "That payee already has a rule." }, 409);
  }
  if (!state?.category) {
    return context.json({ error: "Category not found." }, 404);
  }
  return context.json(
    {
      error: `An organization can keep up to ${financeLimits.categorizationRules} rules.`,
    },
    409,
  );
}

async function applyRule(context: FinanceContext) {
  const id = context.req.param("id") ?? "";
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const results = await activityBatch(database, actor.apiKey, [
    database
      .prepare(
        `SELECT id FROM finance_categorization_rules
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(id, organizationId),
    ...applyStatements(
      database,
      actor.userId,
      new Date().toISOString(),
      id,
      organizationId,
    ),
  ]);
  if (!results[0]?.results.length) return ruleNotFound(context);
  return respond(context, financeRoutes.applyCategorizationRule, {
    applied: appliedCount(results),
  });
}

/**
 * Fills the rule's uncategorized transactions as the requester, whose
 * categorization each one records (by trigger). The leading count reads the
 * same rows the write changes, inside the same transaction: D1 counts rows
 * that triggers write in `meta.changes`, so the write's own count overstates
 * them. The event names the rule and how many it filled; filling none records
 * nothing.
 */
function applyStatements(
  database: D1Database,
  userId: string,
  now: string,
  id: string,
  organizationId: string,
) {
  const rule = `FROM finance_categorization_rules AS rule
    WHERE rule.id = ? AND rule.organization_id = ?`;
  return [
    database
      .prepare(`SELECT (SELECT COUNT(*) ${uncategorized}) AS applied ${rule}`)
      .bind(id, organizationId),
    ruleEvent(database, userId, now, id, {
      action: "finance.categorization_rule_applied",
      details: `json_object('payeeName', rule.payee_name,
        'categoryId', category.id, 'categoryName', category.name,
        'count', (SELECT COUNT(*) ${uncategorized}))`,
      organizationId,
      when: `EXISTS (SELECT 1 ${uncategorized})`,
    }),
    database
      .prepare(
        `INSERT INTO finance_transaction_annotations
           (transaction_id, organization_id, note, labels, reviewed,
            expense_category_id, created_by, updated_by, created_at, updated_at)
         SELECT txn.id, txn.organization_id, '', '[]', 0,
                rule.expense_category_id, ?1, ?1, ?2, ?2
         FROM finance_categorization_rules AS rule
         JOIN plaid_transactions AS txn
           ON txn.organization_id = rule.organization_id
          AND txn.source_status = 'active'
          AND ${payee} = rule.payee_name
         WHERE rule.id = ?3 AND rule.organization_id = ?4
         ON CONFLICT(transaction_id) DO UPDATE SET
           expense_category_id = excluded.expense_category_id,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at
         WHERE expense_category_id IS NULL`,
      )
      .bind(userId, now, id, organizationId),
  ];
}

/** The count `applyStatements` read, from the batch results that hold it. */
function appliedCount(results: D1Result[]) {
  const row = results.at(-3)?.results[0] as { applied: number } | undefined;
  return row?.applied ?? 0;
}

async function deleteRule(context: FinanceContext) {
  const id = context.req.param("id") ?? "";
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  const results = await activityBatch(database, actor.apiKey, [
    ruleEvent(database, actor.userId, new Date().toISOString(), id, {
      action: "finance.categorization_rule_deleted",
      details: `json_object('payeeName', rule.payee_name,
        'categoryId', category.id, 'categoryName', category.name)`,
      organizationId,
    }),
    database
      .prepare(
        `DELETE FROM finance_categorization_rules
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(id, organizationId),
  ]);
  if (!results.at(-1)?.meta.changes) return ruleNotFound(context);
  return context.body(null, 204);
}

/**
 * An event for one stored rule, under its category, labelled and detailed
 * from the rows as the batch reads them. Nothing is recorded when the rule
 * is gone or belongs to another organization, or `when` does not hold.
 */
function ruleEvent(
  database: D1Database,
  actorId: string,
  occurredAt: string,
  id: string,
  input: {
    action: string;
    /** A JSON expression over the `rule` and `category` rows. */
    details: string;
    organizationId: string;
    when?: string;
  },
) {
  return database
    .prepare(
      `INSERT INTO activity_events (
         organization_id, root_type, root_id, root_label, subject_type,
         subject_id, action, actor_user_id, actor_name, actor_email,
         occurred_at, details
       )
       SELECT rule.organization_id, 'finance_category', category.id,
              category.name, 'finance_categorization_rule', rule.id, ?,
              actor.id, actor.name, actor.email, ?, ${input.details}
       FROM finance_categorization_rules AS rule
       JOIN finance_expense_categories AS category
         ON category.id = rule.expense_category_id
       JOIN user AS actor ON actor.id = ?
       WHERE rule.id = ? AND rule.organization_id = ?
         AND ${input.when ?? "1"}`,
    )
    .bind(input.action, occurredAt, actorId, id, input.organizationId);
}

/**
 * Deletes a category's rules, recording each as deleted by the person
 * deleting the category. Runs in that deletion's batch, before it.
 */
export function deleteCategoryRulesStatements(
  database: D1Database,
  actorId: string,
  occurredAt: string,
  organizationId: string,
  categoryId: string,
) {
  return [
    database
      .prepare(
        `INSERT INTO activity_events (
           organization_id, root_type, root_id, root_label, subject_type,
           subject_id, action, actor_user_id, actor_name, actor_email,
           occurred_at, details
         )
         SELECT rule.organization_id, 'finance_category', category.id,
                category.name, 'finance_categorization_rule', rule.id,
                'finance.categorization_rule_deleted', actor.id, actor.name,
                actor.email, ?, json_object('payeeName', rule.payee_name,
                  'categoryId', category.id, 'categoryName', category.name,
                  'reason', 'category_deleted')
         FROM finance_categorization_rules AS rule
         JOIN finance_expense_categories AS category
           ON category.id = rule.expense_category_id
         JOIN user AS actor ON actor.id = ?
         WHERE rule.organization_id = ? AND rule.expense_category_id = ?`,
      )
      .bind(occurredAt, actorId, organizationId, categoryId),
    database
      .prepare(
        `DELETE FROM finance_categorization_rules
         WHERE organization_id = ? AND expense_category_id = ?`,
      )
      .bind(organizationId, categoryId),
  ];
}

/**
 * Categorizes the page's newly imported transactions that a rule matches and
 * that have no annotation yet, as Balebase's work: the annotation has no
 * editor, and one system event per transaction names the rule. The event
 * reads the annotations this batch inserted (no editor, created now), so a
 * replayed page, whose transactions already have them, records nothing.
 */
export function applyRulesToImported(
  database: D1Database,
  organizationId: string,
  causation: ActivityCausation,
  transactionIds: string[],
) {
  const now = new Date().toISOString();
  const ids = JSON.stringify(transactionIds);
  return [
    database
      .prepare(
        `INSERT INTO finance_transaction_annotations
           (transaction_id, organization_id, note, labels, reviewed,
            expense_category_id, created_by, updated_by, created_at, updated_at)
         SELECT txn.id, txn.organization_id, '', '[]', 0,
                rule.expense_category_id, NULL, NULL, ?1, ?1
         FROM plaid_transactions AS txn
         JOIN finance_categorization_rules AS rule
           ON rule.organization_id = txn.organization_id
          AND rule.payee_name = ${payee}
         WHERE txn.organization_id = ?2
           AND txn.id IN (SELECT value FROM json_each(?3))
           AND txn.source_status = 'active'
         ON CONFLICT(transaction_id) DO NOTHING`,
      )
      .bind(now, organizationId, ids),
    systemActivityRowsStatement(
      database,
      categorizationRuleActor(causation),
      now,
      {
        bindings: [organizationId, ids, now],
        sql: `SELECT txn.organization_id AS organization_id,
                     'finance_transaction' AS root_type, txn.id AS root_id,
                     ${payee} AS root_label,
                     'finance_transaction' AS subject_type,
                     txn.id AS subject_id,
                     'finance.transaction_categorized' AS action,
                     json_object('before', NULL, 'beforeName', NULL,
                       'after', category.id, 'afterName', category.name,
                       'ruleId', rule.id, 'rulePayeeName', rule.payee_name)
                       AS details
              FROM finance_transaction_annotations AS annotation
              JOIN plaid_transactions AS txn
                ON txn.id = annotation.transaction_id
              JOIN finance_expense_categories AS category
                ON category.id = annotation.expense_category_id
              JOIN finance_categorization_rules AS rule
                ON rule.organization_id = txn.organization_id
               AND rule.payee_name = ${payee}
              WHERE annotation.organization_id = ?
                AND annotation.transaction_id IN (SELECT value FROM json_each(?))
                AND annotation.updated_by IS NULL
                AND annotation.created_at = ?`,
      },
    ),
  ];
}

function toRule(row: RuleRow): CategorizationRule {
  return {
    category: { id: row.category_id, name: row.category_name },
    createdAt: row.created_at,
    id: row.id,
    payeeName: row.payee_name,
    uncategorizedCount: row.uncategorized_count,
  };
}

function ruleNotFound(context: FinanceContext) {
  return context.json({ error: "Rule not found." }, 404);
}
