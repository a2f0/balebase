import { describe, expect, it } from "bun:test";
import type { FinanceTransaction } from "@balebase/validators/finance";
import { savedSummary } from "./savedSummary";

const transaction = (
  id: string,
  transactionDate: string,
  expenseCategoryId: string | null,
) => ({ expenseCategoryId, id, transactionDate }) as FinanceTransaction;

const summary = {
  accounts: [],
  configured: true,
  connections: [],
  organizationId: "org",
  userId: "person",
};

describe("saved summaries", () => {
  it("fills per-year counts a summary saved before them lacks", () => {
    const saved = {
      ...summary,
      categories: [
        { id: "meals", name: "Meals", slug: "meals", transactionCount: 3 },
        { id: "travel", name: "Travel", slug: "travel", transactionCount: 0 },
      ],
    };
    const filled = savedSummary(
      saved as unknown as Parameters<typeof savedSummary>[0],
      [
        transaction("a", "2026-03-01", "meals"),
        transaction("b", "2025-12-31", "meals"),
        transaction("c", "2026-01-01", "meals"),
        transaction("d", "2026-01-01", null),
      ],
    );
    expect(filled?.categories).toEqual([
      {
        id: "meals",
        name: "Meals",
        slug: "meals",
        transactionCount: 3,
        transactionCountsByYear: [
          { transactionCount: 1, year: 2025 },
          { transactionCount: 2, year: 2026 },
        ],
      },
      {
        id: "travel",
        name: "Travel",
        slug: "travel",
        transactionCount: 0,
        transactionCountsByYear: [],
      },
    ]);
  });

  it("keeps a current summary, and no summary, as they are", () => {
    const current = {
      ...summary,
      categories: [
        {
          id: "meals",
          name: "Meals",
          slug: "meals",
          transactionCount: 1,
          transactionCountsByYear: [{ transactionCount: 1, year: 2024 }],
        },
      ],
    };
    expect(
      savedSummary(current, [transaction("a", "2026-03-01", "meals")]),
    ).toBe(current);
    expect(savedSummary(null, [])).toBeNull();
  });
});
