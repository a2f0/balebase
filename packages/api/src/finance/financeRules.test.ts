import { describe, expect, it, setSystemTime } from "bun:test";
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
  owner: { id: string; name: string } | null;
  payeeName: string;
  uncategorizedCount: number;
}

/** Twelve report transactions, the first five shown under "Shell". */
async function shellFixture() {
  const fixture = await createFixture();
  const ids = seedTransactions(fixture.database);
  fixture.database
    .query(
      `UPDATE plaid_transactions SET merchant_name = 'Shell'
       WHERE id IN (?, ?, ?, ?, ?)`,
    )
    .run(...ids.slice(0, 5));
  // The bank withdrew the fifth, so rules leave it alone.
  fixture.database
    .query(
      "UPDATE plaid_transactions SET source_status = 'removed' WHERE id = ?",
    )
    .run(ids[4] ?? "");
  const fuel = await createCategory(fixture, "Fuel");
  const meals = await createCategory(fixture, "Meals");
  return { fixture, fuel, ids, meals };
}

function createRule(
  fixture: Fixture,
  body: { applyToExisting: boolean; categoryId: string; payeeName: string },
) {
  return jsonRequest<{ applied: number; rule: Rule }>(
    fixture.app,
    fixture.bindings,
    "/categorization-rules",
    "POST",
    body,
  );
}

function categories(fixture: Fixture) {
  return Object.fromEntries(
    fixture.database
      .query<{ category: string | null; id: string }, []>(
        `SELECT txn.id, annotation.expense_category_id AS category
         FROM plaid_transactions AS txn
         LEFT JOIN finance_transaction_annotations AS annotation
           ON annotation.transaction_id = txn.id
         ORDER BY txn.id`,
      )
      .all()
      .map((row) => [row.id, row.category]),
  );
}

interface EventRow {
  action: string;
  actor_name: string;
  actor_source: string | null;
  actor_type: string;
  actor_user_id: string | null;
  causation_type: string | null;
  details: string;
  root_id: string;
  root_type: string;
  subject_id: string;
  subject_type: string;
}

function events(fixture: Fixture, action: string) {
  return fixture.database
    .query<EventRow, [string]>(
      `SELECT action, actor_name, actor_source, actor_type, actor_user_id,
              causation_type, details, root_id, root_type, subject_id,
              subject_type
       FROM activity_events WHERE action = ? ORDER BY id`,
    )
    .all(action)
    .map((row) => ({
      ...row,
      details: JSON.parse(row.details) as Record<string, unknown>,
    }));
}

describe("categorization rules", () => {
  it("creates a rule without touching existing transactions unless asked", async () => {
    const { fixture, fuel } = await shellFixture();
    const before = categories(fixture);
    const created = await createRule(fixture, {
      applyToExisting: false,
      categoryId: fuel,
      payeeName: "Shell",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      applied: 0,
      rule: {
        category: { id: fuel, name: "Fuel" },
        payeeName: "Shell",
        uncategorizedCount: 4,
      },
    });
    expect(categories(fixture)).toEqual(before);
    expect(events(fixture, "finance.categorization_rule_created")).toEqual([
      expect.objectContaining({
        actor_user_id: "user-1",
        details: { categoryId: fuel, categoryName: "Fuel", payeeName: "Shell" },
        root_id: fuel,
        root_type: "finance_category",
        subject_id: created.body.rule.id,
        subject_type: "finance_categorization_rule",
      }),
    ]);
    expect(events(fixture, "finance.categorization_rule_applied")).toEqual([]);
    const listed = await jsonRequest<{ rules: Rule[] }>(
      fixture.app,
      fixture.bindings,
      "/categorization-rules",
      "GET",
    );
    expect(listed.body.rules).toEqual([created.body.rule]);
  });

  it("fills only the payee's uncategorized transactions, as the requester", async () => {
    const { fixture, fuel, ids, meals } = await shellFixture();
    const [first, second, third] = ids;
    // A category someone chose stays; an annotation without one is filled.
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${first}/category`,
      "PUT",
      { categoryId: meals },
    );
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${second}/annotation`,
      "PATCH",
      { labels: [], note: "Fleet card", reviewed: false },
    );
    // Exact names only: another case or a longer name is another payee.
    fixture.database
      .query("UPDATE plaid_transactions SET merchant_name = ? WHERE id = ?")
      .run("shell", ids[5] ?? "");
    fixture.database
      .query("UPDATE plaid_transactions SET merchant_name = ? WHERE id = ?")
      .run("Shell Oil", ids[6] ?? "");
    const before = categories(fixture);
    const created = await createRule(fixture, {
      applyToExisting: true,
      categoryId: fuel,
      payeeName: "Shell",
    });
    expect(created.status).toBe(201);
    expect(created.body.applied).toBe(3);
    expect(created.body.rule.uncategorizedCount).toBe(0);
    expect(categories(fixture)).toEqual({
      ...before,
      [second ?? ""]: fuel,
      [third ?? ""]: fuel,
      [ids[3] ?? ""]: fuel,
    });
    const categorized = events(fixture, "finance.transaction_categorized");
    expect(
      categorized.filter(
        ({ details }) => (details as { after?: unknown }).after === fuel,
      ),
    ).toHaveLength(3);
    expect(
      categorized.every(
        ({ actor_type, actor_user_id }) =>
          actor_type === "user" && actor_user_id === "user-1",
      ),
    ).toBe(true);
    expect(events(fixture, "finance.categorization_rule_applied")).toEqual([
      expect.objectContaining({
        actor_user_id: "user-1",
        details: {
          categoryId: fuel,
          categoryName: "Fuel",
          count: 3,
          payeeName: "Shell",
        },
        subject_id: created.body.rule.id,
      }),
    ]);
    // Each filled transaction's own history names the rule; the category
    // someone chose before does not.
    const byRule = categorized.filter(
      ({ details }) => (details as { after?: unknown }).after === fuel,
    );
    expect(byRule.map(({ details }) => details)).toEqual(
      Array(3).fill({
        after: fuel,
        afterName: "Fuel",
        before: null,
        beforeName: null,
        ruleId: created.body.rule.id,
        rulePayeeName: "Shell",
      }),
    );
    expect(
      categorized.find(
        ({ details }) => (details as { after?: unknown }).after === meals,
      )?.details,
    ).not.toHaveProperty("ruleId");
    expect(created.body.rule.owner).toEqual({
      id: "user-1",
      name: expect.any(String),
    });
  });

  it("names the rule only on its own application's events, even in the same millisecond", async () => {
    const { fixture, fuel, ids } = await shellFixture();
    const moment = new Date("2026-11-06T12:00:00.000Z");
    // The same person's own category for a Shell transaction, recorded in
    // another request at the very moment the rule is then applied.
    const manual = () =>
      fixture.database
        .query(
          `INSERT INTO activity_events
             (organization_id, root_type, root_id, root_label, subject_type,
              subject_id, action, actor_user_id, actor_name, actor_email,
              occurred_at, details)
           SELECT organization_id, 'finance_transaction', id, 'Shell',
                  'finance_transaction', id, 'finance.transaction_categorized',
                  'user-1', 'User', 'user@example.com', ?,
                  json_object('before', NULL, 'beforeName', NULL,
                              'after', ?, 'afterName', 'Fuel')
           FROM plaid_transactions WHERE id = ?`,
        )
        .run(moment.toISOString(), fuel, ids[0] ?? "");
    const ruleIds = () =>
      events(fixture, "finance.transaction_categorized").map(
        ({ details }) => (details as { ruleId?: string }).ruleId ?? null,
      );
    manual();
    setSystemTime(moment);
    try {
      const created = await createRule(fixture, {
        applyToExisting: false,
        categoryId: fuel,
        payeeName: "Shell",
      });
      const apply = () =>
        jsonRequest<{ applied: number }>(
          fixture.app,
          fixture.bindings,
          `/categorization-rules/${created.body.rule.id}/apply`,
          "POST",
        );
      expect((await apply()).body.applied).toBe(4);
      expect(ruleIds()).toEqual([null, ...Array(4).fill(created.body.rule.id)]);
      // Another hand-chosen category at the same moment, then an application
      // that fills nothing: it relabels nothing.
      manual();
      expect((await apply()).body.applied).toBe(0);
      expect(ruleIds()).toEqual([
        null,
        ...Array(4).fill(created.body.rule.id),
        null,
      ]);
    } finally {
      setSystemTime();
    }
  });

  it("applies an existing rule on request and records nothing when nothing is left", async () => {
    const { fixture, fuel, ids } = await shellFixture();
    const created = await createRule(fixture, {
      applyToExisting: false,
      categoryId: fuel,
      payeeName: "Shell",
    });
    const apply = (id: string) =>
      jsonRequest<{ applied: number }>(
        fixture.app,
        fixture.bindings,
        `/categorization-rules/${id}/apply`,
        "POST",
      );
    expect(await apply(created.body.rule.id)).toMatchObject({
      body: { applied: 4 },
      status: 200,
    });
    expect(categories(fixture)[ids[0] ?? ""]).toBe(fuel);
    expect(await apply(created.body.rule.id)).toMatchObject({
      body: { applied: 0 },
      status: 200,
    });
    expect(events(fixture, "finance.categorization_rule_applied")).toHaveLength(
      1,
    );
    expect((await apply("missing")).status).toBe(404);
  });

  it("refuses a second rule for a payee, a missing category, and past the limit", async () => {
    const { fixture, fuel, meals } = await shellFixture();
    const rule = {
      applyToExisting: false,
      categoryId: fuel,
      payeeName: "Shell",
    };
    expect((await createRule(fixture, rule)).status).toBe(201);
    expect(await createRule(fixture, { ...rule, categoryId: meals })).toEqual(
      expect.objectContaining({
        body: { error: "That payee already has a rule." },
        status: 409,
      }),
    );
    expect(
      (
        await createRule(fixture, {
          ...rule,
          categoryId: "missing",
          payeeName: "Other",
        })
      ).status,
    ).toBe(404);
    for (const body of [
      { ...rule, payeeName: "" },
      { ...rule, payeeName: "x".repeat(201) },
      { categoryId: fuel, payeeName: "Other" },
    ]) {
      expect((await createRule(fixture, body as typeof rule)).status).toBe(400);
    }
    const insert = fixture.database.query(
      `INSERT INTO finance_categorization_rules
         (id, organization_id, payee_name, expense_category_id, created_at)
       VALUES (?, 'org_user-1', ?, ?, '2026-09-01')`,
    );
    for (let index = 1; index < 500; index++) {
      insert.run(`rule-${index}`, `Payee ${index}`, fuel);
    }
    expect(
      await createRule(fixture, { ...rule, payeeName: "One too many" }),
    ).toEqual(
      expect.objectContaining({
        body: { error: "An organization can keep up to 500 rules." },
        status: 409,
      }),
    );
    expect(events(fixture, "finance.categorization_rule_created")).toHaveLength(
      1,
    );
  });

  it("keeps other organizations' rules out of reach", async () => {
    const { fixture, fuel } = await shellFixture();
    fixture.database.run(`INSERT INTO finance_expense_categories
      (id, organization_id, name, slug, created_at, updated_at)
      VALUES ('foreign-category', 'organization-2', 'Fuel', 'fuel', '2026', '2026')`);
    fixture.database.run(`INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at)
      VALUES ('foreign-rule', 'organization-2', 'Shell', 'foreign-category', '2026')`);
    // The other organization's own Shell transaction, which its rule matches.
    fixture.database.run(`INSERT INTO plaid_transactions
      (id, plaid_transaction_id, organization_id, plaid_item_record_id,
       account_record_id, name, merchant_name, amount, transaction_date,
       pending, source_status, updated_at)
      VALUES ('foreign-txn', 'plaid-foreign-txn', 'organization-2',
              'item-report', 'account-report', 'SHELL', 'Shell', 30,
              '2026-08-20', 0, 'active', '2026')`);
    const before = categories(fixture);
    const activity = () =>
      fixture.database
        .query("SELECT COUNT(*) AS count FROM activity_events")
        .get();
    const recorded = activity();
    const listed = await jsonRequest<{ rules: Rule[] }>(
      fixture.app,
      fixture.bindings,
      "/categorization-rules",
      "GET",
    );
    expect(listed.body.rules).toEqual([]);
    for (const [path, method] of [
      ["/categorization-rules/foreign-rule/apply", "POST"],
      ["/categorization-rules/foreign-rule", "DELETE"],
    ] as const) {
      expect(
        (await jsonRequest(fixture.app, fixture.bindings, path, method)).status,
      ).toBe(404);
    }
    expect(categories(fixture)).toEqual(before);
    expect(activity()).toEqual(recorded);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM finance_categorization_rules")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      (
        await createRule(fixture, {
          applyToExisting: true,
          categoryId: "foreign-category",
          payeeName: "Shell",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await createRule(fixture, {
          applyToExisting: false,
          categoryId: fuel,
          payeeName: "Shell",
        })
      ).status,
    ).toBe(201);
  });

  it("records deleting a rule, and a category's rules when it is deleted", async () => {
    const { fixture, fuel, meals } = await shellFixture();
    const shell = await createRule(fixture, {
      applyToExisting: false,
      categoryId: fuel,
      payeeName: "Shell",
    });
    await createRule(fixture, {
      applyToExisting: false,
      categoryId: meals,
      payeeName: "Cafe",
    });
    const remove = (path: string) =>
      jsonRequest(fixture.app, fixture.bindings, path, "DELETE");
    expect(
      (await remove(`/categorization-rules/${shell.body.rule.id}`)).status,
    ).toBe(204);
    expect(
      (await remove(`/categorization-rules/${shell.body.rule.id}`)).status,
    ).toBe(404);
    expect((await remove(`/categories/${meals}`)).status).toBe(204);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM finance_categorization_rules")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      events(fixture, "finance.categorization_rule_deleted").map(
        ({ actor_user_id, details }) => [actor_user_id, details],
      ),
    ).toEqual([
      [
        "user-1",
        { categoryId: fuel, categoryName: "Fuel", payeeName: "Shell" },
      ],
      [
        "user-1",
        {
          categoryId: meals,
          categoryName: "Meals",
          payeeName: "Cafe",
          reason: "category_deleted",
        },
      ],
    ]);
  });

  it("stores nothing when its history cannot be recorded", async () => {
    const { fixture, fuel } = await shellFixture();
    fixture.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'finance.categorization_rule_applied'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const before = categories(fixture);
    const created = await createRule(fixture, {
      applyToExisting: true,
      categoryId: fuel,
      payeeName: "Shell",
    });
    expect(created.status).toBe(500);
    expect(categories(fixture)).toEqual(before);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM finance_categorization_rules")
        .get(),
    ).toEqual({ count: 0 });
    expect(events(fixture, "finance.categorization_rule_created")).toEqual([]);
  });
});

describe("categorization rules on import", () => {
  async function connect(fixture: Fixture) {
    const exchange = await jsonRequest<{ connectionId: string }>(
      fixture.app,
      fixture.bindings,
      "/exchange",
      "POST",
      {
        institutionId: "ins_test",
        institutionName: "First Test Bank",
        publicToken: "public-sandbox-test",
      },
    );
    expect(exchange.status).toBe(201);
    return exchange.body.connectionId;
  }
  async function sync(fixture: Fixture, connectionId: string) {
    const started = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/connections/${connectionId}/sync-jobs`,
      "POST",
    );
    expect(started.status).toBe(202);
  }
  function annotation(fixture: Fixture) {
    return fixture.database
      .query(
        `SELECT annotation.expense_category_id AS category,
                annotation.created_by, annotation.updated_by
         FROM finance_transaction_annotations AS annotation
         JOIN plaid_transactions AS txn ON txn.id = annotation.transaction_id
         WHERE txn.plaid_transaction_id = 'transaction-test-1'`,
      )
      .get();
  }

  it("categorizes a newly imported transaction as Balebase, once", async () => {
    const fixture = await createFixture();
    const meals = await createCategory(fixture, "Meals");
    const rule = await createRule(fixture, {
      applyToExisting: false,
      categoryId: meals,
      payeeName: "Test Cafe",
    });
    const connectionId = await connect(fixture);
    await sync(fixture, connectionId);
    expect(annotation(fixture)).toEqual({
      category: meals,
      created_by: null,
      updated_by: null,
    });
    const recorded = events(fixture, "finance.transaction_categorized");
    expect(recorded).toEqual([
      expect.objectContaining({
        actor_name: "Balebase rules",
        actor_source: "categorizationRule",
        actor_type: "system",
        actor_user_id: null,
        details: {
          after: meals,
          afterName: "Meals",
          before: null,
          beforeName: null,
          ruleId: rule.body.rule.id,
          rulePayeeName: "Test Cafe",
        },
        root_type: "finance_transaction",
      }),
    ]);
    expect(recorded[0]?.causation_type).not.toBeNull();
    // A later sync of the same transaction leaves it and its history alone.
    await sync(fixture, connectionId);
    expect(events(fixture, "finance.transaction_categorized")).toHaveLength(1);
  });

  it("leaves an earlier import alone when a page is replayed after a future-only rule", async () => {
    const fixture = await createFixture();
    const meals = await createCategory(fixture, "Meals");
    const connectionId = await connect(fixture);
    await sync(fixture, connectionId);
    await createRule(fixture, {
      applyToExisting: false,
      categoryId: meals,
      payeeName: "Test Cafe",
    });
    // Plaid sends the transaction as added again (a replayed page).
    fixture.database.run("UPDATE plaid_items SET cursor = NULL");
    await sync(fixture, connectionId);
    expect(annotation(fixture)).toBeNull();
    expect(events(fixture, "finance.transaction_categorized")).toEqual([]);
  });

  it("stores a new transaction only with its rule's category", async () => {
    const fixture = await createFixture();
    const meals = await createCategory(fixture, "Meals");
    await createRule(fixture, {
      applyToExisting: false,
      categoryId: meals,
      payeeName: "Test Cafe",
    });
    fixture.database.exec(`CREATE TRIGGER fail_activity
      BEFORE INSERT ON activity_events
      WHEN NEW.action = 'finance.transaction_categorized'
      BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
    const connectionId = await connect(fixture);
    await sync(fixture, connectionId);
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM plaid_transactions")
        .get(),
    ).toEqual({ count: 0 });
    // The retry finds the transaction new, so the rule still applies.
    fixture.database.exec("DROP TRIGGER fail_activity");
    // The failed page's retry is due at once.
    fixture.database.run("UPDATE job_runs SET available_at = '2000-01-01'");
    await sync(fixture, connectionId);
    expect(annotation(fixture)).toMatchObject({ category: meals });
    expect(events(fixture, "finance.transaction_categorized")).toHaveLength(1);
  });

  it("never replaces a category someone chose, and skips payees without a rule", async () => {
    const fixture = await createFixture();
    const meals = await createCategory(fixture, "Meals");
    const travel = await createCategory(fixture, "Travel");
    const connectionId = await connect(fixture);
    await sync(fixture, connectionId);
    expect(annotation(fixture)).toBeNull();
    const id = (
      fixture.database
        .query(
          "SELECT id FROM plaid_transactions WHERE plaid_transaction_id = 'transaction-test-1'",
        )
        .get() as { id: string }
    ).id;
    await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${id}/category`,
      "PUT",
      { categoryId: travel },
    );
    await createRule(fixture, {
      applyToExisting: false,
      categoryId: meals,
      payeeName: "Test Cafe",
    });
    // Plaid sends the transaction as added again (a replayed page).
    fixture.database.run("UPDATE plaid_items SET cursor = NULL");
    await sync(fixture, connectionId);
    expect(annotation(fixture)).toMatchObject({ category: travel });
    expect(
      events(fixture, "finance.transaction_categorized").map(
        ({ actor_type }) => actor_type,
      ),
    ).toEqual(["user"]);
  });
});
