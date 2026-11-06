import type { CategorizationRule } from "@balebase/validators/finance";
import type { FinanceContext } from "./financeContext";

export interface RuleRow {
  category_id: string;
  category_name: string;
  created_at: string;
  id: string;
  owner_id: string | null;
  owner_name: string | null;
  payee_name: string;
  uncategorized_count: number;
}

/** The name a transaction is shown under, as rules and the name filter match it. */
export const payee = "COALESCE(txn.merchant_name, txn.name)";

/**
 * A payee's active transactions without a category, for the `rule` in scope:
 * the rows applying it fills.
 */
export const uncategorized = `FROM plaid_transactions AS txn
  LEFT JOIN finance_transaction_annotations AS annotation
    ON annotation.transaction_id = txn.id
  WHERE txn.organization_id = rule.organization_id
    AND txn.source_status = 'active'
    AND ${payee} = rule.payee_name
    AND annotation.expense_category_id IS NULL`;

export function readRules(
  database: D1Database,
  organizationId: string,
  id?: string,
) {
  return database
    .prepare(
      `SELECT rule.id, rule.payee_name, rule.created_at,
              category.id AS category_id, category.name AS category_name,
              owner.id AS owner_id, owner.name AS owner_name,
              (SELECT COUNT(*) ${uncategorized}) AS uncategorized_count
       FROM finance_categorization_rules AS rule
       JOIN finance_expense_categories AS category
         ON category.id = rule.expense_category_id
       LEFT JOIN "user" AS owner ON owner.id = rule.created_by
       WHERE rule.organization_id = ? AND (? IS NULL OR rule.id = ?)
       ORDER BY rule.payee_name`,
    )
    .bind(organizationId, id ?? null, id ?? null)
    .all<RuleRow>();
}

export function toRule(row: RuleRow): CategorizationRule {
  return {
    category: { id: row.category_id, name: row.category_name },
    createdAt: row.created_at,
    id: row.id,
    owner:
      row.owner_id === null
        ? null
        : { id: row.owner_id, name: row.owner_name ?? "" },
    payeeName: row.payee_name,
    uncategorizedCount: row.uncategorized_count,
  };
}

export function ruleNotFound(context: FinanceContext) {
  return context.json({ error: "Rule not found." }, 404);
}
