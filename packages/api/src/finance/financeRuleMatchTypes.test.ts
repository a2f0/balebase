import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { CategorizationRule } from "@balebase/validators/finance";
import { financeRuleMatchTypes } from "@balebase/validators/rules";
import type { Hono } from "hono";
import {
  createCategory,
  createFixture,
  jsonRequest,
  seedTransactions,
} from "../testing/financeFixture";
import type { ApiTestEnv } from "../testing/session";
import type { Bindings } from "../types";
import { applyRulesToImported } from "./financeRules";

interface Fixture {
  app: Hono<ApiTestEnv>;
  bindings: Bindings;
  database: Database;
}

function request<T>(
  fixture: Fixture,
  path: string,
  method: string,
  body?: unknown,
) {
  return jsonRequest<T>(fixture.app, fixture.bindings, path, method, body);
}

function categorized(fixture: Fixture) {
  return fixture.database
    .query<{ details: string; root_id: string }, []>(
      `SELECT details, root_id FROM activity_events
       WHERE action = 'finance.transaction_categorized' ORDER BY id`,
    )
    .all()
    .map((row) => ({
      id: row.root_id,
      ...(JSON.parse(row.details) as {
        after: string;
        ruleId?: string;
        ruleMatchType?: string;
        rulePayeeName?: string;
      }),
    }));
}

const literal = " A%_\\B ";

async function matchingFixture() {
  const fixture = await createFixture();
  const ids = seedTransactions(fixture.database);
  const categoryId = await createCategory(fixture, "Matched");
  const keptCategoryId = await createCategory(fixture, "Kept");
  const names = [
    literal,
    `${literal}station`,
    `near${literal}station`,
    literal.toLowerCase(),
    " AxxB ",
    null,
    "Different merchant",
    literal,
    literal,
    literal.trim(),
    " A%_B ",
    "Other",
  ];
  const update = fixture.database.query(
    "UPDATE plaid_transactions SET merchant_name = ?, name = ? WHERE id = ?",
  );
  ids.forEach((id, index) => {
    update.run(names[index] ?? null, literal, id);
  });
  await request(fixture, `/transactions/${ids[7]}/category`, "PUT", {
    categoryId: keptCategoryId,
  });
  return { categoryId, fixture, ids, keptCategoryId };
}

describe("literal rule matching", () => {
  for (const matchType of financeRuleMatchTypes) {
    for (const application of ["manual", "create", "import"] as const) {
      it(`${matchType}: counts and ${application} match literal case-sensitive displayed payees`, async () => {
        const { categoryId, fixture, ids, keptCategoryId } =
          await matchingFixture();
        const expectedIds = ids.filter(
          (_, index) =>
            index === 0 ||
            index === 5 ||
            (matchType !== "exact" && index === 1) ||
            (matchType === "contains" && index === 2),
        );
        const created = await request<{
          applied: number;
          rule: CategorizationRule;
        }>(fixture, "/categorization-rules", "POST", {
          applyToExisting: application === "create",
          categoryId,
          matchType,
          payeeName: literal,
        });
        expect(created.status).toBe(201);
        expect(created.body.rule.matchType).toBe(matchType);
        expect(created.body.rule.payeeName).toBe(literal);
        expect(created.body.rule.uncategorizedCount).toBe(
          application === "create" ? 0 : expectedIds.length,
        );
        if (application === "manual") {
          const applied = await request<{ applied: number }>(
            fixture,
            `/categorization-rules/${created.body.rule.id}/apply`,
            "POST",
          );
          expect(applied.body.applied).toBe(expectedIds.length);
        } else if (application === "import") {
          await fixture.bindings.DB.batch(
            applyRulesToImported(
              fixture.bindings.DB,
              "org_user-1",
              { id: "import", type: "job_run" },
              ids,
            ),
          );
        } else {
          expect(created.body.applied).toBe(expectedIds.length);
        }
        const changes = categorized(fixture).filter(
          (event) => event.ruleId === created.body.rule.id,
        );
        expect(changes.map((event) => event.id).sort()).toEqual(
          expectedIds.sort(),
        );
        for (const event of changes) {
          expect(event).toMatchObject({
            after: categoryId,
            ruleMatchType: matchType,
            rulePayeeName: literal,
          });
        }
        expect(
          fixture.database
            .query(
              "SELECT expense_category_id FROM finance_transaction_annotations WHERE transaction_id = ?",
            )
            .get(ids[7] ?? ""),
        ).toEqual({ expense_category_id: keptCategoryId });
        const listed = await request<{ rules: CategorizationRule[] }>(
          fixture,
          "/categorization-rules",
          "GET",
        );
        expect(listed.body.rules[0]).toMatchObject({
          matchType,
          uncategorizedCount: 0,
        });
      });
    }
  }
});

const overlappingRules = [
  {
    id: "exact",
    mode: "exact",
    payee: "Test Cafe Downtown",
    created: "2026-03-01",
  },
  {
    id: "short-prefix",
    mode: "startsWith",
    payee: "Test",
    created: "2026-01-01",
  },
  {
    id: "long-prefix",
    mode: "startsWith",
    payee: "Test Cafe",
    created: "2026-02-01",
  },
  {
    id: "long-contains",
    mode: "contains",
    payee: "Cafe Downtown",
    created: "2026-03-01",
  },
  { id: "z-old", mode: "contains", payee: "Cafe", created: "2026-01-01" },
  { id: "a-new", mode: "contains", payee: "Down", created: "2026-02-01" },
  { id: "a-old", mode: "contains", payee: "town", created: "2026-01-01" },
] as const;

async function overlapFixture(ruleIds: string[]) {
  const fixture = await createFixture();
  const ids = seedTransactions(fixture.database);
  fixture.database
    .query(
      "UPDATE plaid_transactions SET merchant_name = 'Test Cafe Downtown' WHERE id = ?",
    )
    .run(ids[0] ?? "");
  const categories = new Map<string, string>();
  for (const rule of overlappingRules.filter((rule) =>
    ruleIds.includes(rule.id),
  )) {
    const categoryId = await createCategory(fixture, rule.id);
    categories.set(rule.id, categoryId);
    fixture.database
      .query(`INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at, match_type)
      VALUES (?, 'org_user-1', ?, ?, ?, ?)`)
      .run(rule.id, rule.payee, categoryId, rule.created, rule.mode);
  }
  return { categories, fixture, id: ids[0] ?? "" };
}

describe("overlapping rule selection", () => {
  for (const [ruleIds, winner] of [
    [["exact", "long-prefix", "long-contains"], "exact"],
    [["short-prefix", "long-contains"], "short-prefix"],
    [["short-prefix", "long-prefix", "long-contains"], "long-prefix"],
    [["long-contains", "z-old"], "long-contains"],
    [["z-old", "a-new"], "z-old"],
    [["z-old", "a-old"], "a-old"],
  ] as const) {
    it(`imports exactly one attribution for winner ${winner} among ${ruleIds.join(", ")}`, async () => {
      const { categories, fixture, id } = await overlapFixture([...ruleIds]);
      await fixture.bindings.DB.batch(
        applyRulesToImported(
          fixture.bindings.DB,
          "org_user-1",
          { id: "import", type: "job_run" },
          [id],
        ),
      );
      const rule = overlappingRules.find((rule) => rule.id === winner);
      expect(categorized(fixture)).toEqual([
        expect.objectContaining({
          id,
          after: categories.get(winner),
          ruleId: winner,
          ruleMatchType: rule?.mode,
          rulePayeeName: rule?.payee,
        }),
      ]);
      expect(
        fixture.database
          .query(
            "SELECT expense_category_id FROM finance_transaction_annotations WHERE transaction_id = ?",
          )
          .get(id),
      ).toEqual({ expense_category_id: categories.get(winner) });
    });
  }

  it("manually applies the selected broad rule even when an exact rule also matches", async () => {
    const { categories, fixture, id } = await overlapFixture([
      "exact",
      "long-contains",
    ]);
    const result = await request<{ applied: number }>(
      fixture,
      "/categorization-rules/long-contains/apply",
      "POST",
    );
    expect(result.body.applied).toBe(1);
    expect(categorized(fixture)).toEqual([
      expect.objectContaining({
        id,
        after: categories.get("long-contains"),
        ruleId: "long-contains",
        ruleMatchType: "contains",
      }),
    ]);
  });
});

it("edits only the mode, refreshes counts, records both modes and leaves existing categories intact", async () => {
  const { categoryId, fixture } = await matchingFixture();
  const created = await request<{ rule: CategorizationRule }>(
    fixture,
    "/categorization-rules",
    "POST",
    {
      applyToExisting: false,
      categoryId,
      matchType: "exact",
      payeeName: literal,
    },
  );
  expect(created.body.rule.uncategorizedCount).toBe(2);
  const path = `/categorization-rules/${created.body.rule.id}`;
  const body = { categoryId, matchType: "contains", payeeName: literal };
  const updated = await request<{ rule: CategorizationRule }>(
    fixture,
    path,
    "PATCH",
    body,
  );
  expect(updated.status).toBe(200);
  expect(updated.body.rule).toMatchObject({
    matchType: "contains",
    uncategorizedCount: 4,
  });
  const updates = fixture.database.query<{ details: string }, []>(
    "SELECT details FROM activity_events WHERE action = 'finance.categorization_rule_updated'",
  );
  expect(updates.all().map((event) => JSON.parse(event.details))).toEqual([
    expect.objectContaining({
      matchType: "contains",
      previousMatchType: "exact",
    }),
  ]);
  expect((await request(fixture, path, "PATCH", body)).status).toBe(200);
  expect(updates.all()).toHaveLength(1);
  expect(categorized(fixture)).toHaveLength(1);
  const applied = await request<{ applied: number }>(
    fixture,
    `${path}/apply`,
    "POST",
  );
  expect(applied.body.applied).toBe(4);
  expect(
    categorized(fixture).filter((event) => event.ruleMatchType === "contains"),
  ).toHaveLength(4);
});

it("requires a valid mode on create and edit, and keeps one rule per payee across modes", async () => {
  const fixture = await createFixture();
  const categoryId = await createCategory(fixture, "Fuel");
  const input = { applyToExisting: false, categoryId, payeeName: "Shell" };
  for (const matchType of [undefined, null, "EXACT", "endsWith", "", 1]) {
    expect(
      (
        await request(fixture, "/categorization-rules", "POST", {
          ...input,
          matchType,
        })
      ).status,
    ).toBe(400);
  }
  const created = await request<{ rule: CategorizationRule }>(
    fixture,
    "/categorization-rules",
    "POST",
    { ...input, matchType: "startsWith" },
  );
  expect(created.status).toBe(201);
  expect(
    (
      await request(fixture, "/categorization-rules", "POST", {
        ...input,
        matchType: "contains",
      })
    ).status,
  ).toBe(409);
  const path = `/categorization-rules/${created.body.rule.id}`;
  for (const matchType of [undefined, null, "EXACT", "endsWith", "", 1]) {
    expect(
      (
        await request(fixture, path, "PATCH", {
          categoryId,
          payeeName: "Shell",
          matchType,
        })
      ).status,
    ).toBe(400);
  }
  expect(
    fixture.database
      .query("SELECT match_type FROM finance_categorization_rules")
      .all(),
  ).toEqual([{ match_type: "startsWith" }]);
  expect(
    fixture.database
      .query(
        "SELECT COUNT(*) AS count FROM activity_events WHERE action = 'finance.categorization_rule_updated'",
      )
      .get(),
  ).toEqual({ count: 0 });
});

it("rolls back a mode edit when its audit event fails", async () => {
  const fixture = await createFixture();
  const categoryId = await createCategory(fixture, "Fuel");
  const created = await request<{ rule: CategorizationRule }>(
    fixture,
    "/categorization-rules",
    "POST",
    {
      applyToExisting: false,
      categoryId,
      matchType: "exact",
      payeeName: "Shell",
    },
  );
  fixture.database.exec(`CREATE TRIGGER fail_rule_edit BEFORE INSERT ON activity_events
    WHEN NEW.action = 'finance.categorization_rule_updated'
    BEGIN SELECT RAISE(ABORT, 'activity unavailable'); END`);
  expect(
    (
      await request(
        fixture,
        `/categorization-rules/${created.body.rule.id}`,
        "PATCH",
        {
          categoryId,
          matchType: "contains",
          payeeName: "Shell",
        },
      )
    ).status,
  ).toBe(500);
  expect(
    fixture.database
      .query("SELECT match_type FROM finance_categorization_rules")
      .all(),
  ).toEqual([{ match_type: "exact" }]);
});

it("imports overlapping rules once and leaves replayed transactions and events alone", async () => {
  const fixture = await createFixture();
  const broadCategory = await createCategory(fixture, "Broad");
  const exactCategory = await createCategory(fixture, "Exact");
  for (const [payeeName, matchType] of [
    ["Cafe", "contains"],
    ["Test", "startsWith"],
  ] as const) {
    expect(
      (
        await request(fixture, "/categorization-rules", "POST", {
          applyToExisting: false,
          categoryId: broadCategory,
          matchType,
          payeeName,
        })
      ).status,
    ).toBe(201);
  }
  const exact = await request<{ rule: CategorizationRule }>(
    fixture,
    "/categorization-rules",
    "POST",
    {
      applyToExisting: false,
      categoryId: exactCategory,
      matchType: "exact",
      payeeName: "Test Cafe",
    },
  );
  const exchange = await request<{ connectionId: string }>(
    fixture,
    "/exchange",
    "POST",
    {
      institutionId: "ins_test",
      institutionName: "First Test Bank",
      publicToken: "public-sandbox-test",
    },
  );
  expect(exchange.status).toBe(201);
  const syncPath = `/connections/${exchange.body.connectionId}/sync-jobs`;
  expect((await request(fixture, syncPath, "POST")).status).toBe(202);
  const recorded = categorized(fixture);
  expect(recorded).toEqual([
    expect.objectContaining({
      after: exactCategory,
      ruleId: exact.body.rule.id,
      ruleMatchType: "exact",
    }),
  ]);
  fixture.database.run("UPDATE plaid_items SET cursor = NULL");
  expect((await request(fixture, syncPath, "POST")).status).toBe(202);
  expect(categorized(fixture)).toEqual(recorded);
});

it("ignores another organization's more specific rule on import", async () => {
  const { fixture, id, categories } = await overlapFixture(["long-contains"]);
  fixture.database.exec(`
    INSERT INTO finance_expense_categories
      (id, organization_id, name, slug, created_at, updated_at)
    VALUES ('foreign-category', 'organization-2', 'Foreign', 'foreign', '2026', '2026');
    INSERT INTO finance_categorization_rules
      (id, organization_id, payee_name, expense_category_id, created_at, match_type)
    VALUES ('foreign-rule', 'organization-2', 'Test Cafe Downtown', 'foreign-category', '2026', 'exact');`);
  await fixture.bindings.DB.batch(
    applyRulesToImported(
      fixture.bindings.DB,
      "org_user-1",
      { id: "import", type: "job_run" },
      [id],
    ),
  );
  expect(categorized(fixture)).toEqual([
    expect.objectContaining({
      id,
      after: categories.get("long-contains"),
      ruleId: "long-contains",
      ruleMatchType: "contains",
    }),
  ]);
});
