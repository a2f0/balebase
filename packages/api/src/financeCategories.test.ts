import { describe, expect, it } from "bun:test";
import { applyMigrations, createTestDatabase } from "./testing/database";
import {
  type Category,
  createCategory,
  createFixture,
  type FinanceListing,
  financePath,
  jsonRequest,
  seedTransactions,
  testApp,
} from "./testing/financeFixture";
import { seedOrganization } from "./testing/seed";
import type { Bindings } from "./types";

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

  it("migrates free-text category overrides into categories", async () => {
    // The legacy annotations name transactions this test does not seed.
    const database = createTestDatabase({ before: "0034", foreignKeys: false });
    const overrides: [string, string, string | null][] = [
      ["txn-a", "org-a", "Client meal"],
      ["txn-b", "org-a", " client MEAL "],
      ["txn-c", "org-a", "Travel"],
      ["txn-d", "org-b", "Travel"],
      ["txn-e", "org-b", "   "],
      ["txn-f", "org-b", null],
    ];
    for (const [transactionId, organizationId, override] of overrides) {
      database
        .query(
          `INSERT INTO finance_transaction_annotations
             (transaction_id, organization_id, category_override, created_by,
              updated_by, created_at, updated_at)
           VALUES (?, ?, ?, 'user-1', 'user-1', ?, ?)`,
        )
        .run(
          transactionId,
          organizationId,
          override,
          "2026-08-19T12:00:00.000Z",
          "2026-08-19T12:00:00.000Z",
        );
    }
    applyMigrations(database, { from: "0034" });

    const categories = database
      .query(
        `SELECT organization_id, name FROM finance_expense_categories
         ORDER BY organization_id, name`,
      )
      .all();
    expect(categories).toEqual([
      { name: "Client meal", organization_id: "org-a" },
      { name: "Travel", organization_id: "org-a" },
      { name: "Travel", organization_id: "org-b" },
    ]);
    const assigned = database
      .query(
        `SELECT annotation.transaction_id, category.name, category.organization_id
         FROM finance_transaction_annotations AS annotation
         LEFT JOIN finance_expense_categories AS category
           ON category.id = annotation.expense_category_id
         ORDER BY annotation.transaction_id`,
      )
      .all();
    expect(assigned).toEqual([
      {
        name: "Client meal",
        organization_id: "org-a",
        transaction_id: "txn-a",
      },
      {
        name: "Client meal",
        organization_id: "org-a",
        transaction_id: "txn-b",
      },
      { name: "Travel", organization_id: "org-a", transaction_id: "txn-c" },
      { name: "Travel", organization_id: "org-b", transaction_id: "txn-d" },
      { name: null, organization_id: null, transaction_id: "txn-e" },
      { name: null, organization_id: null, transaction_id: "txn-f" },
    ]);
  });

  it("backfills category slugs that are unique in each organization", async () => {
    const database = createTestDatabase({ before: "0065" });
    for (const id of ["org-a", "org-b"]) seedOrganization(database, { id });
    const categories: [string, string, string][] = [
      ["a1234567-first", "org-a", "Meals & drinks"],
      ["b1234567-second", "org-a", "Meals/drinks"],
      ["c1234567-third", "org-a", "Meals drinks 2"],
      ["d1234567-fourth", "org-a", "Uncategorized"],
      ["e1234567-fifth", "org-a", "Taxes (2026)"],
      ["f1234567-sixth", "org-a", "🍔"],
      ["g1234567-seventh", "org-a", "Café"],
      ["h1234567-eighth", "org-b", "Meals/drinks"],
      ["j1234567-tenth", "org-a", "b1234567-second"],
    ];
    for (const [index, [id, organizationId, name]] of categories.entries()) {
      database
        .query(
          `INSERT INTO finance_expense_categories
             (id, organization_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, organizationId, name, `2026-08-0${index + 1}`, "");
    }
    applyMigrations(database, { from: "0065" });

    expect(
      database
        .query("SELECT id, slug FROM finance_expense_categories ORDER BY id")
        .all(),
    ).toEqual([
      { id: "a1234567-first", slug: "meals-drinks" },
      { id: "b1234567-second", slug: "meals-drinks-2--b1234567-second" },
      { id: "c1234567-third", slug: "meals-drinks-2" },
      { id: "d1234567-fourth", slug: "uncategorized-2" },
      { id: "e1234567-fifth", slug: "taxes-2026" },
      { id: "f1234567-sixth", slug: "category" },
      // Unlike the API, the backfill cannot fold accents.
      { id: "g1234567-seventh", slug: "caf" },
      { id: "h1234567-eighth", slug: "meals-drinks" },
      { id: "j1234567-tenth", slug: "b1234567-second" },
    ]);

    // Categories the previous Worker creates during deployment get a slug.
    database.run(
      `INSERT INTO finance_expense_categories
         (id, organization_id, name, created_at, updated_at)
       VALUES ('i1234567-ninth', 'org-a', 'Postage', '', '')`,
    );
    expect(
      database
        .query(
          "SELECT slug FROM finance_expense_categories WHERE id = 'i1234567-ninth'",
        )
        .get(),
    ).toEqual({ slug: "i1234567-ninth" });
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
