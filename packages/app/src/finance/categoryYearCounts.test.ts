import { describe, expect, it } from "bun:test";
import {
  categoryYearCounts,
  periodTotals,
  yearCountsOf,
} from "./categoryYearCounts";

const usd = (total: number) => ({ currencyCode: "USD", total });

describe("category year counts", () => {
  const moved = new Map([
    ["a", { amount: 10.1, currencyCode: "USD", transactionDate: "2025-04-01" }],
    ["b", { amount: 20.2, currencyCode: "USD", transactionDate: "2026-04-01" }],
    ["c", { amount: 5, currencyCode: "EUR", transactionDate: "2026-05-01" }],
  ]);

  it("moves each transaction's count and amount between categories", () => {
    const changes = [
      { from: null, id: "a", to: "meals" },
      { from: "meals", id: "b", to: "travel" },
      { from: "travel", id: "c", to: "meals" },
    ];
    expect(
      categoryYearCounts(
        "meals",
        [{ totals: [usd(-20.2)], transactionCount: 1, year: 2026 }],
        changes,
        moved,
      ),
    ).toEqual([
      { totals: [usd(-10.1)], transactionCount: 1, year: 2025 },
      {
        totals: [
          { currencyCode: "EUR", total: -5 },
          { currencyCode: "USD", total: 0 },
        ],
        transactionCount: 1,
        year: 2026,
      },
    ]);
    expect(
      categoryYearCounts(
        "travel",
        [
          {
            totals: [{ currencyCode: "EUR", total: -5 }],
            transactionCount: 1,
            year: 2026,
          },
        ],
        changes,
        moved,
      ),
    ).toEqual([
      {
        totals: [{ currencyCode: "EUR", total: 0 }, usd(-20.2)],
        transactionCount: 1,
        year: 2026,
      },
    ]);
  });

  it("drops emptied years and reads a copy saved without them", () => {
    expect(
      categoryYearCounts(
        "meals",
        [{ totals: [usd(-10.1)], transactionCount: 1, year: 2025 }],
        [{ from: "meals", id: "a", to: null }],
        moved,
      ),
    ).toEqual([]);
    expect(
      categoryYearCounts(
        "meals",
        undefined,
        [{ from: null, id: "b", to: "meals" }],
        moved,
      ),
    ).toEqual([{ totals: [usd(-20.2)], transactionCount: 1, year: 2026 }]);
  });

  it("sums a period's totals per currency, refunds included", () => {
    const years = yearCountsOf([
      { amount: 0.1, currencyCode: "USD", transactionDate: "2025-01-01" },
      { amount: 0.2, currencyCode: "USD", transactionDate: "2026-01-01" },
      { amount: -0.05, currencyCode: "USD", transactionDate: "2026-02-01" },
      { amount: 3, currencyCode: null, transactionDate: "2026-03-01" },
    ]);
    expect(years.map(({ transactionCount }) => transactionCount)).toEqual([
      1, 3,
    ]);
    expect(periodTotals(years, null)).toEqual([
      { currencyCode: null, total: -3 },
      usd(-0.25),
    ]);
    expect(periodTotals(years, 2025)).toEqual([usd(-0.1)]);
    expect(periodTotals(years, 2024)).toEqual([]);
  });
});
