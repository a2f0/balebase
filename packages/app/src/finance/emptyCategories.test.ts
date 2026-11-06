import { describe, expect, it } from "bun:test";
import {
  periodTransactionCount,
  readHideEmptyCategories,
  storeHideEmptyCategories,
  visibleCategories,
} from "./emptyCategories";

const category = (name: string, counts: Record<number, number> = {}) => {
  const transactionCountsByYear = Object.entries(counts).map(
    ([year, transactionCount]) => ({
      totals: [],
      transactionCount,
      year: Number(year),
    }),
  );
  return {
    id: name,
    name,
    slug: name.toLowerCase(),
    transactionCount: transactionCountsByYear.reduce(
      (sum, entry) => sum + entry.transactionCount,
      0,
    ),
    transactionCountsByYear,
  };
};

describe("empty categories", () => {
  it("shows every category until asked to hide empty ones", () => {
    const meals = category("Meals", { 2025: 2 });
    const categories = [meals, category("Travel")];
    expect(visibleCategories(categories, false, null)).toEqual({
      hidden: 0,
      shown: categories,
    });
    expect(visibleCategories(categories, true, null)).toEqual({
      hidden: 1,
      shown: [meals],
    });
  });

  it("counts and hides by the period's year", () => {
    const meals = category("Meals", { 2025: 2, 2026: 1 });
    const travel = category("Travel", { 2025: 3 });
    expect(periodTransactionCount(meals, null)).toBe(3);
    expect(periodTransactionCount(meals, 2026)).toBe(1);
    expect(periodTransactionCount(travel, 2026)).toBe(0);
    expect(visibleCategories([meals, travel], true, 2026)).toEqual({
      hidden: 1,
      shown: [meals],
    });
    expect(visibleCategories([meals, travel], true, 2025).hidden).toBe(0);
    expect(visibleCategories([meals, travel], true, 2024).hidden).toBe(2);
  });

  it("loads and stores the choice, defaulting to showing everything", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readHideEmptyCategories(storage)).toBe(false);
    storeHideEmptyCategories(true, storage);
    expect(readHideEmptyCategories(storage)).toBe(true);
    storeHideEmptyCategories(false, storage);
    expect(readHideEmptyCategories(storage)).toBe(false);
  });

  it("tolerates storage that refuses reads and writes", () => {
    const refuse = () => {
      throw new Error("Storage is disabled.");
    };
    expect(readHideEmptyCategories({ getItem: refuse })).toBe(false);
    expect(() =>
      storeHideEmptyCategories(true, { setItem: refuse }),
    ).not.toThrow();
  });
});
