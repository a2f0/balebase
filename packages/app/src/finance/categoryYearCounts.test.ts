import { describe, expect, it } from "bun:test";
import { categoryYearCounts } from "./categoryYearCounts";

describe("category year counts", () => {
  const years = new Map([
    ["a", 2025],
    ["b", 2026],
    ["c", 2026],
  ]);

  it("moves each transaction's year between categories", () => {
    const changes = [
      { from: null, id: "a", to: "meals" },
      { from: "meals", id: "b", to: "travel" },
      { from: "travel", id: "c", to: "meals" },
    ];
    expect(
      categoryYearCounts(
        "meals",
        [{ transactionCount: 1, year: 2026 }],
        changes,
        years,
      ),
    ).toEqual([
      { transactionCount: 1, year: 2025 },
      { transactionCount: 1, year: 2026 },
    ]);
    expect(
      categoryYearCounts(
        "travel",
        [{ transactionCount: 1, year: 2026 }],
        changes,
        years,
      ),
    ).toEqual([{ transactionCount: 1, year: 2026 }]);
  });

  it("drops emptied years and reads a copy saved without them", () => {
    expect(
      categoryYearCounts(
        "meals",
        [{ transactionCount: 1, year: 2025 }],
        [{ from: "meals", id: "a", to: null }],
        years,
      ),
    ).toEqual([]);
    expect(
      categoryYearCounts(
        "meals",
        undefined,
        [{ from: null, id: "b", to: "meals" }],
        years,
      ),
    ).toEqual([{ transactionCount: 1, year: 2026 }]);
  });
});
