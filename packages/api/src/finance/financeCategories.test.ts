import { describe, expect, it } from "bun:test";
import {
  type Category,
  createCategory,
  createFixture,
  type FinanceListing,
  financePath,
  jsonRequest,
  seedTransactions,
  testApp,
} from "../testing/financeFixture";
import type { Bindings } from "../types";

describe("expense categories", () => {
  it("manages organization categories with case-insensitive unique names", async () => {
    const fixture = await createFixture();
    const created = await jsonRequest<{ category: Category }>(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "  Meals   and  drinks " },
    );
    expect(created.status).toBe(201);
    expect(created.body.category).toMatchObject({
      name: "Meals and drinks",
      slug: "meals-and-drinks",
      transactionCount: 0,
    });
    const categoryId = created.body.category.id;

    const duplicate = await jsonRequest(
      fixture.app,
      fixture.bindings,
      "/categories",
      "POST",
      { name: "meals AND drinks" },
    );
    expect(duplicate.status).toBe(409);
    for (const name of ["", "   ", "x".repeat(61), 42]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        "/categories",
        "POST",
        { name },
      );
      expect(invalid).toMatchObject({
        body: { error: "Category names need 1 to 60 characters." },
        status: 400,
      });
    }

    const renamed = await jsonRequest<{ category: Category }>(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "Client meals" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.category).toMatchObject({
      id: categoryId,
      name: "Client meals",
      slug: "client-meals",
    });
    const sameNameOtherCase = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "client MEALS" },
    );
    expect(sameNameOtherCase.status).toBe(200);

    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    expect(defaults.status).toBe(200);
    expect(defaults.body.categories).toHaveLength(17);
    const again = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    expect(again.body.categories).toHaveLength(17);
    const names = again.body.categories.map(({ name }) => name);
    expect(names).toContain("Charitable contributions");
    expect(names).toContain("Personal");
    expect(names).toContain("Travel");
    const clash = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "travel" },
    );
    expect(clash.status).toBe(409);

    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<{ categories: Category[] }>(
      otherOrganization,
      fixture.bindings,
      "/categories",
      "GET",
    );
    expect(hidden.body.categories).toEqual([]);
    const cannotRename = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/categories/${categoryId}`,
      "PATCH",
      { name: "Taken over" },
    );
    expect(cannotRename.status).toBe(404);
    const cannotDelete = await otherOrganization.request(
      financePath(`/categories/${categoryId}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(cannotDelete.status).toBe(404);
  });

  it("slugs category names uniquely within each organization", async () => {
    const fixture = await createFixture();
    const create = async (name: string, app = fixture.app) => {
      const created = await jsonRequest<{ category: Category }>(
        app,
        fixture.bindings,
        "/categories",
        "POST",
        { name },
      );
      expect(created.status).toBe(201);
      return created.body.category;
    };
    const cafe = await create("Café & Bar");
    expect(cafe.slug).toBe("cafe-bar");
    const repeat = await create("--Cafe/Bar--");
    expect(repeat.slug).toBe("cafe-bar-2");
    expect((await create("Uncategorized")).slug).toBe("uncategorized-2");
    expect((await create("🍔")).slug).toBe("category");
    expect((await create("Travel!")).slug).toBe("travel");
    const elsewhere = await create(
      "Café & Bar",
      testApp("organization-2", fixture.requestPlaid),
    );
    expect(elsewhere.slug).toBe("cafe-bar");

    const rename = async (id: string, name: string) => {
      const renamed = await jsonRequest<{ category: Category }>(
        fixture.app,
        fixture.bindings,
        `/categories/${id}`,
        "PATCH",
        { name },
      );
      expect(renamed.status).toBe(200);
      return renamed.body.category.slug;
    };
    expect(await rename(repeat.id, "Cafe Bar!")).toBe("cafe-bar-2");
    expect(await rename(cafe.id, "Coffee")).toBe("coffee");
    expect(await rename(repeat.id, "Cafe & bar")).toBe("cafe-bar");

    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories/defaults",
      "POST",
    );
    const slugs = defaults.body.categories.map(({ name, slug }) => [
      name,
      slug,
    ]);
    expect(slugs).toContainEqual(["Travel", "travel-2"]);
    expect(slugs).toContainEqual([
      "Software and subscriptions",
      "software-and-subscriptions",
    ]);
    expect(() =>
      fixture.database.run(
        `INSERT INTO finance_expense_categories
           (id, organization_id, name, slug, created_at, updated_at)
         VALUES ('copy', 'org_user-1', 'Copy', 'coffee', '', '')`,
      ),
    ).toThrow(/UNIQUE/);
  });

  it("chooses another slug when a concurrent write takes it first", async () => {
    const fixture = await createFixture();
    const tea = await createCategory(fixture, "Tea");
    const raced = await jsonRequest<{ category: Category }>(
      fixture.app,
      raceForSlug(fixture, "cafe-bar"),
      "/categories",
      "POST",
      { name: "Cafe/Bar" },
    );
    expect(raced.status).toBe(201);
    expect(raced.body.category.slug).toBe("cafe-bar-2");
    const renamed = await jsonRequest<{ category: Category }>(
      fixture.app,
      raceForSlug(fixture, "snacks"),
      `/categories/${tea}`,
      "PATCH",
      { name: "Snacks" },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.category.slug).toBe("snacks-2");
    const defaults = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      raceForSlug(fixture, "travel"),
      "/categories/defaults",
      "POST",
    );
    expect(
      defaults.body.categories.find(({ name }) => name === "Travel")?.slug,
    ).toBe("travel-2");
    expect(defaults.body.categories).toHaveLength(21);
  });

  it("splits each category's count and total by year and currency", async () => {
    const fixture = await createFixture();
    const ids = seedTransactions(fixture.database);
    const meals = await createCategory(fixture, "Meals");
    await createCategory(fixture, "Travel");
    // Rows 0, 2 (a refund), and 10 (EUR) stay in 2026, row 3 moves to 2025,
    // and row 8 was removed.
    fixture.database
      .query(
        "UPDATE plaid_transactions SET transaction_date = '2025-12-31' WHERE id = ?",
      )
      .run(ids[3] ?? "");
    for (const index of [0, 2, 3, 8, 10]) {
      fixture.database
        .query(
          `INSERT INTO finance_transaction_annotations
             (transaction_id, organization_id, expense_category_id,
              created_by, updated_by, created_at, updated_at)
           VALUES (?, 'org_user-1', ?, 'user-1', 'user-1',
                   '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        )
        .run(ids[index] ?? "", meals);
    }
    const listed = await jsonRequest<{ categories: Category[] }>(
      fixture.app,
      fixture.bindings,
      "/categories",
      "GET",
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.categories.map(
        ({ name, transactionCount, transactionCountsByYear }) => ({
          name,
          transactionCount,
          transactionCountsByYear,
        }),
      ),
    ).toEqual([
      {
        name: "Meals",
        transactionCount: 4,
        transactionCountsByYear: [
          {
            totals: [{ currencyCode: "USD", total: -300 }],
            transactionCount: 1,
            year: 2025,
          },
          {
            totals: [
              { currencyCode: "EUR", total: -45 },
              { currencyCode: "USD", total: -80 },
            ],
            transactionCount: 3,
            year: 2026,
          },
        ],
      },
      { name: "Travel", transactionCount: 0, transactionCountsByYear: [] },
    ]);
  });

  it("assigns at most one category per transaction and unassigns on delete", async () => {
    const fixture = await createFixture();
    const [transactionId] = seedTransactions(fixture.database);
    if (!transactionId) throw new Error("Missing seeded transaction.");
    const meals = await createCategory(fixture, "Meals");
    const travel = await createCategory(fixture, "Travel");

    for (const categoryId of [meals, travel]) {
      const assigned = await jsonRequest<{ expenseCategoryId: string }>(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        { categoryId },
      );
      expect(assigned.status).toBe(200);
      expect(assigned.body.expenseCategoryId).toBe(categoryId);
    }
    const listing = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    const transaction = listing.body.transactions.find(
      ({ id }) => id === transactionId,
    );
    expect(transaction?.expenseCategoryId).toBe(travel);
    expect(listing.body.categories).toMatchObject([
      { name: "Meals", transactionCount: 0 },
      { name: "Travel", transactionCount: 1 },
    ]);
    const annotations = fixture.database
      .query(
        "SELECT COUNT(*) AS count FROM finance_transaction_annotations WHERE transaction_id = ?",
      )
      .get(transactionId) as { count: number };
    expect(annotations.count).toBe(1);

    for (const body of [{}, { categoryId: 7 }, { categoryId: "" }, null]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${transactionId}/category`,
        "PUT",
        body,
      );
      expect(invalid).toMatchObject({
        body: { error: "A category or null is required." },
        status: 400,
      });
    }
    const unknownCategory = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: "missing" },
    );
    expect(unknownCategory.status).toBe(404);
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const foreignTransaction = await jsonRequest(
      otherOrganization,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: null },
    );
    expect(foreignTransaction.status).toBe(404);

    const deleted = await fixture.app.request(
      financePath(`/categories/${travel}`),
      { method: "DELETE" },
      fixture.bindings,
    );
    expect(deleted.status).toBe(204);
    const afterDelete = await jsonRequest<FinanceListing>(
      fixture.app,
      fixture.bindings,
      "/",
      "GET",
    );
    expect(
      afterDelete.body.transactions.find(({ id }) => id === transactionId)
        ?.expenseCategoryId,
    ).toBeNull();
    expect(afterDelete.body.categories.map(({ name }) => name)).toEqual([
      "Meals",
    ]);

    const cleared = await jsonRequest(
      fixture.app,
      fixture.bindings,
      `/transactions/${transactionId}/category`,
      "PUT",
      { categoryId: null },
    );
    expect(cleared.status).toBe(200);
  });

  it("categorizes many transactions at once, recording only real changes", async () => {
    const fixture = await createFixture();
    const [first, second, third, untouched, doomed] = seedTransactions(
      fixture.database,
    );
    if (!first || !second || !third || !untouched || !doomed) {
      throw new Error("Missing seeded transactions.");
    }
    const meals = await createCategory(fixture, "Meals");
    const travel = await createCategory(fixture, "Travel");
    // An annotated transaction already in Meals keeps its note, unrecorded.
    fixture.database
      .query(
        `INSERT INTO finance_transaction_annotations
           (transaction_id, organization_id, note, labels, reviewed,
            expense_category_id, created_by, updated_by, created_at, updated_at)
         VALUES (?, 'org_user-1', 'keep me', '[]', 0, ?, 'user-1', 'user-1',
                 '2026-08-31T12:00:00.000Z', '2026-08-31T12:00:00.000Z')`,
      )
      .run(third, meals);
    const events = () =>
      fixture.database
        .query(
          `SELECT root_id, json_extract(details, '$.afterName') AS name
           FROM activity_events
           WHERE action = 'finance.transaction_categorized'
           ORDER BY root_id`,
        )
        .all() as { name: string | null; root_id: string }[];
    const seeded = events();
    const bulk = (body: unknown, app = fixture.app) =>
      jsonRequest<{
        expenseCategoryId: string | null;
        transactionIds: string[];
      }>(app, fixture.bindings, "/transactions/category", "PUT", body);
    const categoryOf = async () => {
      const listing = await jsonRequest<FinanceListing>(
        fixture.app,
        fixture.bindings,
        "/",
        "GET",
      );
      return Object.fromEntries(
        listing.body.transactions.map(({ expenseCategoryId, id }) => [
          id,
          expenseCategoryId,
        ]),
      );
    };

    const assigned = await bulk({
      categoryId: meals,
      transactionIds: [first, second, third, first],
    });
    expect(assigned).toMatchObject({
      body: {
        expenseCategoryId: meals,
        transactionIds: [first, second, third],
      },
      status: 200,
    });
    expect(await categoryOf()).toMatchObject({
      [first]: meals,
      [second]: meals,
      [third]: meals,
      [untouched]: null,
    });
    expect(events().filter(({ root_id }) => root_id !== third)).toEqual([
      { name: "Meals", root_id: first },
      { name: "Meals", root_id: second },
    ]);
    expect(events()).toHaveLength(seeded.length + 2);
    const kept = fixture.database
      .query(
        "SELECT note FROM finance_transaction_annotations WHERE transaction_id = ?",
      )
      .get(third) as { note: string };
    expect(kept.note).toBe("keep me");

    // An unknown or foreign transaction rejects the whole request.
    for (const [app, ids] of [
      [fixture.app, [first, "missing"]],
      [testApp("organization-2", fixture.requestPlaid), [first]],
    ] as const) {
      const rejected = await bulk(
        { categoryId: travel, transactionIds: ids },
        app,
      );
      expect(rejected.status).toBe(404);
    }
    expect(
      await bulk({ categoryId: "missing", transactionIds: [first] }),
    ).toMatchObject({ body: { error: "Category not found." }, status: 404 });
    for (const body of [
      { categoryId: travel, transactionIds: [] },
      { categoryId: travel },
      { transactionIds: [first] },
      { categoryId: travel, transactionIds: Array(251).fill(first) },
    ]) {
      expect(await bulk(body)).toMatchObject({
        body: {
          error: "A category or null and 1 to 250 transactions are required.",
        },
        status: 400,
      });
    }
    expect((await categoryOf())[first]).toBe(meals);

    // A transaction deleted while the request runs rejects the whole batch.
    fixture.hooks.before("FROM plaid_transactions AS txn", () => {
      fixture.database
        .query("DELETE FROM plaid_transactions WHERE id = ?")
        .run(doomed);
    });
    expect(
      await bulk({ categoryId: travel, transactionIds: [untouched, doomed] }),
    ).toMatchObject({ body: { error: "Transaction not found." }, status: 404 });
    expect((await categoryOf())[untouched]).toBeNull();

    // A category deleted while the request runs leaves every row alone.
    fixture.hooks.before("FROM plaid_transactions AS txn", () => {
      fixture.database
        .query("DELETE FROM finance_expense_categories WHERE id = ?")
        .run(travel);
    });
    expect(
      await bulk({ categoryId: travel, transactionIds: [first, untouched] }),
    ).toMatchObject({ body: { error: "Category not found." }, status: 404 });
    expect(await categoryOf()).toMatchObject({
      [first]: meals,
      [untouched]: null,
    });

    const cleared = await bulk({
      categoryId: null,
      transactionIds: [first, second],
    });
    expect(cleared.status).toBe(200);
    expect(await categoryOf()).toMatchObject({
      [first]: null,
      [second]: null,
      [third]: meals,
    });
    expect(events()).toHaveLength(seeded.length + 4);
    expect(events().filter(({ name }) => name === null)).toEqual([
      { name: null, root_id: first },
      { name: null, root_id: second },
    ]);
  });

  it("reports expense totals by category with transfers and income excluded", async () => {
    const fixture = await createFixture();
    const ids = seedTransactions(fixture.database);
    const meals = await createCategory(fixture, "Meals");
    const software = await createCategory(fixture, "Software");
    await createCategory(fixture, "Travel");
    const assignments: [number, string][] = [
      [0, meals],
      [1, meals],
      [2, meals],
      [9, meals],
      [11, software],
    ];
    for (const [index, categoryId] of assignments) {
      const assigned = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/transactions/${ids[index]}/category`,
        "PUT",
        { categoryId },
      );
      expect(assigned.status).toBe(200);
    }

    const august = await jsonRequest<ExpenseReport>(
      fixture.app,
      fixture.bindings,
      "/reports/expenses?from=2026-08-01&to=2026-08-31",
      "GET",
    );
    expect(august.status).toBe(200);
    expect(august.body.from).toBe("2026-08-01");
    expect(august.body.to).toBe("2026-08-31");
    expect(august.body.currencies.map(({ currency }) => currency)).toEqual([
      "EUR",
      "USD",
    ]);
    const usd = august.body.currencies.find(
      ({ currency }) => currency === "USD",
    );
    expect(usd).toEqual({
      categories: [
        { id: null, name: "Uncategorized", total: 300, transactionCount: 1 },
        { id: meals, name: "Meals", total: 130.25, transactionCount: 3 },
        { id: software, name: "Software", total: 25, transactionCount: 1 },
        {
          id: expect.any(String),
          name: "Travel",
          total: 0,
          transactionCount: 0,
        },
      ],
      currency: "USD",
      excludedTransfers: { total: 575, transactionCount: 2 },
      total: 455.25,
      transactionCount: 5,
    });
    const eur = august.body.currencies.find(
      ({ currency }) => currency === "EUR",
    );
    expect(eur?.total).toBe(45);
    expect(eur?.categories[0]).toEqual({
      id: null,
      name: "Uncategorized",
      total: 45,
      transactionCount: 1,
    });

    const allTime = await jsonRequest<ExpenseReport>(
      fixture.app,
      fixture.bindings,
      "/reports/expenses",
      "GET",
    );
    const allTimeUsd = allTime.body.currencies.find(
      ({ currency }) => currency === "USD",
    );
    expect(allTime.body.from).toBeNull();
    expect(allTimeUsd?.total).toBe(535.25);
    expect(
      allTimeUsd?.categories.find(({ name }) => name === "Meals"),
    ).toMatchObject({ total: 210.25, transactionCount: 4 });

    for (const query of [
      "?from=2026-13-01",
      "?to=2026-02-30",
      "?from=2026-08-31&to=2026-08-01",
      "?from=yesterday",
    ]) {
      const invalid = await jsonRequest(
        fixture.app,
        fixture.bindings,
        `/reports/expenses${query}`,
        "GET",
      );
      expect(invalid.status).toBe(400);
    }
    const otherOrganization = testApp("organization-2", fixture.requestPlaid);
    const hidden = await jsonRequest<ExpenseReport>(
      otherOrganization,
      fixture.bindings,
      "/reports/expenses",
      "GET",
    );
    expect(hidden.body.currencies).toEqual([]);
  });
});

interface ExpenseReport {
  currencies: {
    categories: {
      id: string | null;
      name: string;
      total: number;
      transactionCount: number;
    }[];
    currency: string;
    excludedTransfers: { total: number; transactionCount: number };
    total: number;
    transactionCount: number;
  }[];
  from: string | null;
  to: string | null;
}

/** Bindings where another category takes `slug` just before the next write. */
function raceForSlug(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  slug: string,
): Bindings {
  // The defaults batch races ahead of its first statement, as D1 serializes it.
  fixture.hooks.before(
    /^\s*(INSERT|UPDATE)\b.*finance_expense_categories\b/,
    () => {
      fixture.database
        .query(
          `INSERT INTO finance_expense_categories
             (id, organization_id, name, slug, created_at, updated_at)
           VALUES (?, 'org_user-1', ?, ?, '', '')`,
        )
        .run(`rival-${slug}`, `Rival ${slug}`, slug);
    },
  );
  return fixture.bindings;
}
