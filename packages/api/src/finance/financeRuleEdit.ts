import { financeRoutes } from "@balebase/validators/finance";
import { activityBatch, requestActor } from "../shared/activity";
import { readBody, respond } from "../shared/respond";
import type { FinanceContext } from "./financeContext";
import { readRules, ruleNotFound, toRule } from "./financeRuleRows";

/**
 * Changes a rule's payee, match mode or category. Transactions it already categorized
 * keep their category, and nothing is categorized now: the rule list shows
 * the new payee's uncategorized transactions, which applying the rule fills.
 * One event, under the new category, names both the old and new rule.
 */
export async function updateRule(context: FinanceContext) {
  const input = await readBody(
    context,
    financeRoutes.updateCategorizationRule,
    "A payee name, a match type, and a category are required.",
  );
  if (input instanceof Response) return input;
  const id = context.req.param("id") ?? "";
  const database = context.env.DB;
  const organizationId = context.get("organizationId");
  const actor = requestActor(context);
  // Both statements hold the same conditions: the rule is this
  // organization's, the category is too, and no other rule has the payee. The
  // event reads the rule before the update and records only a real change.
  const allowed = `rule.id = ?1 AND rule.organization_id = ?2
    AND category.id = ?3 AND category.organization_id = ?2
    AND NOT EXISTS (SELECT 1 FROM finance_categorization_rules AS other
                    WHERE other.organization_id = ?2
                      AND other.payee_name = ?4 AND other.id <> ?1)`;
  const results = await activityBatch(database, actor.apiKey, [
    database
      .prepare(
        `INSERT INTO activity_events (
           organization_id, root_type, root_id, root_label, subject_type,
           subject_id, action, actor_user_id, actor_name, actor_email,
           occurred_at, details
         )
         SELECT rule.organization_id, 'finance_category', category.id,
                category.name, 'finance_categorization_rule', rule.id,
                'finance.categorization_rule_updated', actor.id, actor.name,
                actor.email, ?6,
                json_object('payeeName', ?4, 'categoryId', category.id,
                  'categoryName', category.name,
                  'matchType', ?7,
                  'previousMatchType', rule.match_type,
                  'previousPayeeName', rule.payee_name,
                  'previousCategoryName', previous.name)
         FROM finance_categorization_rules AS rule
         JOIN finance_expense_categories AS previous
           ON previous.id = rule.expense_category_id
         JOIN finance_expense_categories AS category
         JOIN user AS actor ON actor.id = ?5
         WHERE ${allowed}
           AND (rule.payee_name <> ?4 OR rule.expense_category_id <> ?3
                OR rule.match_type <> ?7)`,
      )
      .bind(
        id,
        organizationId,
        input.categoryId,
        input.payeeName,
        actor.userId,
        new Date().toISOString(),
        input.matchType,
      ),
    database
      .prepare(
        `UPDATE finance_categorization_rules AS rule
         SET payee_name = ?4, expense_category_id = ?3,
             match_type = ?5
         WHERE rule.id = ?1 AND rule.organization_id = ?2
           AND EXISTS (SELECT 1 FROM finance_expense_categories AS category
                       WHERE ${allowed})`,
      )
      .bind(
        id,
        organizationId,
        input.categoryId,
        input.payeeName,
        input.matchType,
      ),
  ]);
  if (!results.at(-1)?.meta.changes) return refusedUpdate(context, id, input);
  const rule = (await readRules(database, organizationId, id)).results[0];
  if (!rule) return ruleNotFound(context);
  return respond(context, financeRoutes.updateCategorizationRule, {
    rule: toRule(rule),
  });
}

/** Why an update changed no rule: it is gone, its payee is taken, or the category is. */
async function refusedUpdate(
  context: FinanceContext,
  id: string,
  input: { categoryId: string; payeeName: string },
) {
  const state = await context.env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM finance_categorization_rules
               WHERE organization_id = ?1 AND id = ?2) AS rule,
       EXISTS (SELECT 1 FROM finance_categorization_rules
               WHERE organization_id = ?1 AND payee_name = ?3
                 AND id <> ?2) AS taken,
       EXISTS (SELECT 1 FROM finance_expense_categories
               WHERE organization_id = ?1 AND id = ?4) AS category`,
  )
    .bind(context.get("organizationId"), id, input.payeeName, input.categoryId)
    .first<{ category: number; rule: number; taken: number }>();
  if (!state?.rule) return ruleNotFound(context);
  if (state.taken) {
    return context.json({ error: "That payee already has a rule." }, 409);
  }
  return context.json({ error: "Category not found." }, 404);
}
