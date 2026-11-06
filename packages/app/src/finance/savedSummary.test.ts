import { describe, expect, it } from "bun:test";
import type { FinanceTransaction } from "@balebase/validators/finance";
import { savedSummary } from "./savedSummary";

const transaction = (
  id: string,
  transactionDate: string,
  expenseCategoryId: string | null,
  amount = 1,
) =>
  ({
    amount,
    currencyCode: "USD",
    expenseCategoryId,
    id,
    transactionDate,
  }) as FinanceTransaction;

const summary = {
  accounts: [],
  configured: true,
  connections: [],
  organizationId: "org",
  userId: "person",
};

type Saved = Parameters<typeof savedSummary>[0];

describe("saved summaries", () => {
  const transactions = [
    transaction("a", "2026-03-01", "meals", 4),
    transaction("b", "2025-12-31", "meals", 2.5),
    transaction("c", "2026-01-01", "meals", -1),
    transaction("d", "2026-01-01", null),
  ];
  const meals = {
    id: "meals",
    name: "Meals",
    slug: "meals",
    transactionCount: 3,
    transactionCountsByYear: [
      {
        totals: [{ currencyCode: "USD", total: -2.5 }],
        transactionCount: 1,
        year: 2025,
      },
      {
        totals: [{ currencyCode: "USD", total: -3 }],
        transactionCount: 2,
        year: 2026,
      },
    ],
  };

  it("fills per-year counts and totals a summary saved before them lacks", () => {
    const saved = {
      ...summary,
      categories: [
        { id: "meals", name: "Meals", slug: "meals", transactionCount: 3 },
        { id: "travel", name: "Travel", slug: "travel", transactionCount: 0 },
      ],
    };
    expect(
      savedSummary(saved as unknown as Saved, transactions)?.categories,
    ).toEqual([
      meals,
      {
        id: "travel",
        name: "Travel",
        slug: "travel",
        transactionCount: 0,
        transactionCountsByYear: [],
      },
    ]);
  });

  it("fills totals into per-year counts saved without them", () => {
    const saved = {
      ...summary,
      categories: [
        {
          ...meals,
          transactionCountsByYear: [
            { transactionCount: 1, year: 2025 },
            { transactionCount: 2, year: 2026 },
          ],
        },
      ],
    };
    expect(
      savedSummary(saved as unknown as Saved, transactions)?.categories,
    ).toEqual([meals]);
  });

  it("keeps a current summary, and no summary, as they are", () => {
    const current = { ...summary, categories: [meals] };
    expect(savedSummary(current, [])).toBe(current);
    expect(savedSummary(null, [])).toBeNull();
  });
});
