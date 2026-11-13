import { describe, expect, it } from "bun:test";
import type { FinanceRuleMatchType } from "@balebase/validators/rules";
import {
  createCategory,
  createFixture,
  jsonRequest,
  seedTransactions,
} from "../testing/financeFixture";

type Fixture = Awaited<ReturnType<typeof createFixture>>;

interface Rule {
  category: { id: string; name: string };
  id: string;
  matchType: FinanceRuleMatchType;
  payeeName: string;
  uncategorizedCount: number;
}

/** Report transactions: three shown under "Shell", two under "Chevron". */
async function ruleFixture() {
  const fixture = await createFixture();
  const ids = seedTransactions(fixture.database);
  const name = fixture.database.query(
    "UPDATE plaid_transactions SET merchant_name = ? WHERE id = ?",
  );
  for (const id of ids.slice(0, 3)) name.run("Shell", id);
  for (const id of ids.slice(3, 5)) name.run("Chevron", id);
  const fuel = await createCategory(fixture, "Fuel");
  const travel = await createCategory(fixture, "Travel");
  const request = <T>(path: string, method: string, body?: unknown) =>
    jsonRequest<T>(fixture.app, fixture.bindings, path, method, body);
  const create = async (payeeName: string, categoryId: string) =>
    (
      await request<{ rule: Rule }>("/categorization-rules", "POST", {
        applyToExisting: false,
        categoryId,
        matchType: "exact",
        payeeName,
      })
    ).body.rule;
  const update = (id: string, payeeName: string, categoryId: string) =>
    request<{ error?: string; rule: Rule }>(
      `/categorization-rules/${id}`,
      "PATCH",
      { categoryId, matchType: "exact", payeeName },
    );
  return { create, fixture, fuel, ids, request, travel, update };
}

function updates(fixture: Fixture) {
  return fixture.database
    .query<{ actor_user_id: string; details: string; root_id: string }, []>(
      `SELECT actor_user_id, details, root_id FROM activity_events
       WHERE action = 'finance.categorization_rule_updated' ORDER BY id`,
    )
    .all()
    .map((row) => ({ ...row, details: JSON.parse(row.details) as unknown }));
}

function categorized(fixture: Fixture) {
  return fixture.database
    .query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM finance_transaction_annotations
       WHERE expense_category_id IS NOT NULL`,
    )
    .get()?.count;
}

describe("editing categorization rules", () => {
  it("changes the payee and category, recording both, and categorizes nothing", async () => {
    const { create, fixture, fuel, travel, update } = await ruleFixture();
    const rule = await create("Shell", fuel);
    const edited = await update(rule.id, "Chevron", travel);
    expect(edited.status).toBe(200);
    expect(edited.body.rule).toMatchObject({
      category: { id: travel, name: "Travel" },
      id: rule.id,
      payeeName: "Chevron",
      uncategorizedCount: 2,
    });
    expect(categorized(fixture)).toBe(0);
    expect(updates(fixture)).toEqual([
      {
        actor_user_id: "user-1",
        details: {
          categoryId: travel,
          categoryName: "Travel",
          matchType: "exact",
          payeeName: "Chevron",
          previousCategoryName: "Fuel",
          previousMatchType: "exact",
          previousPayeeName: "Shell",
        },
        root_id: travel,
      },
    ]);
    // Saving it unchanged records nothing.
    expect((await update(rule.id, "Chevron", travel)).status).toBe(200);
    expect(updates(fixture)).toHaveLength(1);
  });

  it("refuses a taken payee, a missing category, or a missing rule, recording nothing", async () => {
    const { create, fixture, fuel, travel, update } = await ruleFixture();
    const shell = await create("Shell", fuel);
    await create("Chevron", travel);
    const taken = await update(shell.id, "Chevron", fuel);
    expect(taken).toMatchObject({
      body: { error: "That payee already has a rule." },
      status: 409,
    });
    expect((await update(shell.id, "Shell", "gone")).status).toBe(404);
    expect((await update("gone", "Shell", fuel)).body.error).toBe(
      "Rule not found.",
    );
    expect((await update(shell.id, "", fuel)).status, "an empty payee").toBe(
      400,
    );
    expect(updates(fixture)).toEqual([]);
    expect(
      fixture.database
        .query(
          "SELECT payee_name, expense_category_id FROM finance_categorization_rules WHERE id = ?",
        )
        .get(shell.id),
    ).toEqual({ expense_category_id: fuel, payee_name: "Shell" });
  });

  it("keeps other organizations' rules and categories out of reach", async () => {
    const { create, fixture, fuel, update } = await ruleFixture();
    fixture.database.run(`INSERT INTO finance_expense_categories
      (id, organization_id, name, slug, created_at, updated_at)
      VALUES ('foreign-category', 'organization-2', 'Fuel', 'fuel', '2026', '2026')`);
    fixture.database.run(`INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at)
      VALUES ('foreign-rule', 'organization-2', 'Exxon', 'foreign-category', '2026')`);
    const own = await create("Shell", fuel);
    expect((await update("foreign-rule", "Exxon", fuel)).status).toBe(404);
    expect((await update(own.id, "Shell", "foreign-category")).status).toBe(
      404,
    );
    // Another organization's rule for a payee does not take it here.
    expect((await update(own.id, "Exxon", fuel)).status).toBe(200);
    expect(
      fixture.database
        .query(
          "SELECT organization_id, payee_name, expense_category_id FROM finance_categorization_rules ORDER BY id",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        {
          expense_category_id: "foreign-category",
          organization_id: "organization-2",
          payee_name: "Exxon",
        },
      ]),
    );
    expect(updates(fixture)).toHaveLength(1);
  });

  it("applies the edited rule to its new payee's transactions on request", async () => {
    const { create, fixture, fuel, request, travel, update } =
      await ruleFixture();
    const rule = await create("Shell", fuel);
    await update(rule.id, "Chevron", travel);
    const applied = await request<{ applied: number }>(
      `/categorization-rules/${rule.id}/apply`,
      "POST",
    );
    expect(applied.body.applied).toBe(2);
    expect(categorized(fixture)).toBe(2);
  });
});
